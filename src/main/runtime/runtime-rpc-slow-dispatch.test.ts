import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { ALL_RPC_METHODS } from './rpc/methods'
import { readRuntimeMetadata } from './runtime-metadata'
import type { RpcResponse } from './rpc/core'
import { OrcaRuntimeRpcServer, SLOW_DISPATCH_KEEPALIVE_MAX_MS } from './runtime-rpc'
import {
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS
} from './rpc/unix-socket-transport'

function request(server: OrcaRuntimeRpcServer, method: string): string {
  return JSON.stringify({
    id: `${method}-request`,
    authToken: server['authToken'],
    method,
    params: {}
  })
}

function response(server: OrcaRuntimeRpcServer, id: string): Record<string, unknown> {
  return {
    id,
    ok: true,
    result: { accepted: true },
    _meta: { runtimeId: server['runtime'].getRuntimeId() }
  }
}

function sendLocalRequest(
  endpoint: string,
  authToken: string,
  method: string,
  params: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    const id = `${method}-client-request`
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (frame._keepalive === true) {
          continue
        }
        socket.end()
        resolve(frame)
        return
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, authToken, method, params })}\n`)
    })
  })
}

describe('slow local RPC dispatches', () => {
  it('response is not lost when a slow create outlives the socket idle window', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-slow-dispatch-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      socketIdleTimeoutMs: 100,
      keepaliveIntervalMs: 20
    })
    const handlerCompleted = { value: false }
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 260))
      handlerCompleted.value = true
      return {
        id: req.id,
        ok: true,
        result: { worktree: { id: 'worktree-test' } },
        _meta: { runtimeId: runtime.getRuntimeId() }
      }
    })

    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata || !metadata.authToken || !metadata.transports[0]) {
        throw new Error('runtime metadata was not written')
      }
      const result = await sendLocalRequest(
        metadata.transports[0].endpoint,
        metadata.authToken,
        'worktree.create',
        { repo: 'id:repo', name: 'slow-create' }
      )

      expect(result).toMatchObject({ ok: true })
      expect(handlerCompleted.value).toBe(true)
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.create' }),
        { signal: undefined }
      )
    } finally {
      await server.stop()
      dispatch.mockRestore()
    }
  })

  it('arms keepalive without long-poll admission or abort wiring', async () => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-slow-dispatch-')),
      longPollCap: 1
    })
    const createKeepalive = vi.fn()
    const waitKeepalive = vi.fn()
    const createAbort = new AbortController()
    const waitAbort = new AbortController()
    const signals = new Map<string, AbortSignal | undefined>()
    const dispatch = vi
      .spyOn(server['dispatcher'], 'dispatch')
      .mockImplementation(async (req, options) => {
        signals.set(req.method, options?.signal)
        return response(server, req.id) as RpcResponse
      })

    const [createResult, waitResult] = await Promise.all([
      server['handleMessage'](request(server, 'worktree.create'), {
        signal: createAbort.signal,
        startKeepalive: createKeepalive
      }),
      server['handleMessage'](request(server, 'terminal.wait'), {
        signal: waitAbort.signal,
        startKeepalive: waitKeepalive
      })
    ])

    expect(createResult).toMatchObject({ ok: true })
    expect(waitResult).toMatchObject({ ok: true })
    expect(createKeepalive).toHaveBeenCalledWith(SLOW_DISPATCH_KEEPALIVE_MAX_MS)
    expect(waitKeepalive).toHaveBeenCalledWith()
    expect(signals.get('worktree.create')).toBeUndefined()
    expect(signals.get('terminal.wait')).toBe(waitAbort.signal)
    expect(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS).toBe(30_000)
    expect(DEFAULT_KEEPALIVE_INTERVAL_MS).toBe(10_000)
    dispatch.mockRestore()
  })

  it('emits keepalive frames before a slow create terminal frame', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-slow-dispatch-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      socketIdleTimeoutMs: 100,
      keepaliveIntervalMs: 20
    })
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 130))
      return {
        id: req.id,
        ok: true,
        result: { accepted: true },
        _meta: { runtimeId: runtime.getRuntimeId() }
      }
    })

    await server.start()
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata || !metadata.transports[0]) {
        throw new Error('runtime transport metadata was not written')
      }
      const frames: Record<string, unknown>[] = []
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(metadata.transports[0].endpoint)
        let buffer = ''
        socket.setEncoding('utf8')
        socket.once('error', reject)
        socket.on('data', (chunk: string) => {
          buffer += chunk
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
          }
          if (frames.some((frame) => frame._keepalive !== true)) {
            socket.end()
            resolve()
          }
        })
        socket.on('connect', () => {
          socket.write(
            `${JSON.stringify({
              id: 'frame-request',
              authToken: server['authToken'],
              method: 'worktree.create',
              params: {}
            })}\n`
          )
        })
      })
      expect(frames.some((frame) => frame._keepalive === true)).toBe(true)
      expect(frames.at(-1)).toMatchObject({ ok: true })
    } finally {
      await server.stop()
    }
  })

  it('keeps the classifier aligned with the registered RPC methods', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    expect(
      ['worktree.create', 'browser.tabCreate', 'browser.snapshot'].every((name) =>
        registered.has(name)
      )
    ).toBe(true)
  })
})
