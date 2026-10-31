import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Socket } from 'node:net'
import type * as Net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import { sendRequest } from './transport'
import { formatCliError } from '../cli-error'
import { RuntimeClient } from './client'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { requestWorktreeRemoval } from '../handlers/worktree-removal-request'

vi.mock('node:net', async (importOriginal) => {
  const net = await importOriginal<typeof Net>()
  return { ...net, createConnection: vi.fn(net.createConnection) }
})

const roots: string[] = []
const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function requestSocket(): Socket {
  const created = vi.mocked(createConnection).mock.results.at(-1)
  if (created?.type !== 'return') {
    throw new Error('Expected a local runtime connection')
  }
  return created.value
}

describe('runtime transport timeout validation', () => {
  it.each([-1, 1.5, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timer delay %s before transport discovery',
    async (timeoutMs) => {
      const metadata: RuntimeMetadata = {
        runtimeId: 'runtime-1',
        pid: 123,
        transports: [],
        authToken: 'token',
        startedAt: 1
      }

      await expect(sendRequest(metadata, 'status.get', undefined, timeoutMs)).rejects.toMatchObject(
        {
          code: 'invalid_argument'
        }
      )
    }
  )
})

// These fixtures create Unix domain sockets rather than Windows named pipes.
describe.skipIf(process.platform === 'win32')('runtime transport', () => {
  it('rejects a responding replacement runtime with retry advice in human output', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    roots.push(userDataPath)
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request: { id: string } = JSON.parse(String(data).trim())
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {},
            _meta: { runtimeId: 'runtime-replacement' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-original',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }
    const error: unknown = await sendRequest(metadata, 'status.get', undefined, 1000).catch(
      (error: unknown) => error
    )

    expect(error).toMatchObject({ code: 'runtime_unavailable' })
    expect(formatCliError(error)).toBe(
      'The Orca runtime changed while the request was in flight.\nNext step: Retry the command.'
    )
  })

  it.each(['preflight', 'mutation'] as const)(
    'reports a timeout during %s truthfully',
    async (phase) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-removal-timeout-'))
      roots.push(directory)
      const endpoint = join(directory, 'runtime.sock')
      const received = Promise.withResolvers<void>()
      const methods: string[] = []
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('data', (data) => {
          const request = JSON.parse(String(data).trim())
          methods.push(request.method)
          if (phase === 'mutation' && request.method === 'status.get') {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: { capabilities: ['worktree.remove-branch-policy.v1'] },
                _meta: { runtimeId: 'timeout' }
              })}\n`
            )
          } else {
            received.resolve()
          }
        })
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeFileSync(
        getRuntimeMetadataPath(directory),
        JSON.stringify({
          runtimeId: 'timeout',
          pid: process.pid,
          transports: [{ kind: 'unix', endpoint }],
          authToken: 'test',
          startedAt: 1
        })
      )
      const client = new RuntimeClient(directory, 5000, null, null)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const response = requestWorktreeRemoval(client, {
        worktree: 'id:task',
        hostId: 'local',
        force: false,
        deleteBranch: false,
        runHooks: false,
        allowFailedArchiveHook: false
      }).catch((error: unknown) => error)
      await received.promise
      await vi.runAllTimersAsync()
      expect(await response).toMatchObject({
        code: phase === 'preflight' ? 'runtime_timeout' : 'worktree_removal_in_progress'
      })
      expect(methods).toEqual(
        phase === 'preflight' ? ['status.get'] : ['status.get', 'worktree.rm']
      )
    }
  )

  it.each([
    'capable',
    'absent',
    'empty',
    'unrelated',
    'malformed',
    'error',
    'close',
    'after-send',
    'prepare'
  ] as const)('selects the local wire request without replay: %s', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-selection-'))
    roots.push(root)
    const endpoint = join(root, 'runtime.sock')
    const requests: { id: string; method: string; params?: unknown }[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request: { id: string; method: string; params?: unknown } = JSON.parse(
          String(data).trim()
        )
        requests.push(request)
        if (mode === 'close' || (mode === 'after-send' && request.method === 'worktree.rm')) {
          socket.end()
          return
        }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: mode !== 'error',
            ...(mode === 'error'
              ? { error: { code: 'failed', message: 'status failed' } }
              : {
                  result:
                    request.method === 'worktree.rm'
                      ? { removed: true }
                      : mode === 'capable'
                        ? { capabilities: ['worktree.remove-branch-policy.v1'] }
                        : mode === 'empty'
                          ? { capabilities: [] }
                          : mode === 'unrelated'
                            ? { capabilities: ['future'] }
                            : mode === 'malformed'
                              ? { capabilities: 42 }
                              : {}
                }),
            _meta: { runtimeId: 'selection' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(root),
      JSON.stringify({
        runtimeId: 'selection',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'test',
        startedAt: 1
      })
    )
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const selected = {
      worktree: 'id:task',
      hostId: 'local',
      force: false,
      runHooks: false,
      allowFailedArchiveHook: false
    }
    try {
      if (mode === 'prepare') {
        const dispatched = vi.fn()
        await expect(
          sendRequest(
            {
              runtimeId: 'selection',
              pid: process.pid,
              transports: [{ kind: 'unix', endpoint }],
              authToken: 'test',
              startedAt: 1
            },
            'worktree.rm',
            {},
            5000,
            undefined,
            undefined,
            { requestSelection: { paramsForStatus: () => ({ value: 1n }), onDispatch: dispatched } }
          )
        ).rejects.toThrow()
        expect(dispatched).not.toHaveBeenCalled()
      } else {
        const promise = requestWorktreeRemoval(new RuntimeClient(root, 5000, null, null), {
          ...selected,
          deleteBranch: false
        })
        await (['capable', 'absent', 'empty', 'unrelated'].includes(mode)
          ? expect(promise).resolves.toMatchObject({ result: { removed: true } })
          : expect(promise).rejects.toBeInstanceOf(Error))
      }
      const sent = ['capable', 'absent', 'empty', 'unrelated', 'after-send'].includes(mode)
      expect(requests.map((request) => request.method)).toEqual(
        sent ? ['status.get', 'worktree.rm'] : ['status.get']
      )
      if (sent) {
        expect(requests[1].params).toEqual({
          ...selected,
          allowUnverifiedPtyStop: false,
          waitForBackgroundRemoval: true,
          ...(mode === 'capable' ? { deleteBranch: false } : {})
        })
      }
      expect(warning.mock.calls).toHaveLength(
        ['absent', 'empty', 'unrelated', 'after-send'].includes(mode) ? 1 : 0
      )
    } finally {
      warning.mockRestore()
    }
  })

  it('refreshes the per-call timeout when the runtime sends keepalive frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    roots.push(userDataPath)
    const endpoint = join(userDataPath, 'runtime.sock')
    let acceptRequest!: (request: { id: string; peer: Socket }) => void
    const received = new Promise<{ id: string; peer: Socket }>((resolve) => {
      acceptRequest = resolve
    })
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request: { id: string } = JSON.parse(String(data).trim())
        acceptRequest({ id: request.id, peer: socket })
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = sendRequest<{ satisfied: boolean }>(
      metadata,
      'terminal.wait',
      undefined,
      200
    ).then(
      (value) => ({ response: value }),
      (error: unknown) => ({ error })
    )
    const client = requestSocket()
    const { id, peer } = await received
    await vi.advanceTimersByTimeAsync(150)
    const keepalive = once(client, 'data')
    peer.write('{"_keepalive":true}\n')
    await keepalive
    await vi.advanceTimersByTimeAsync(150)
    peer.write(
      `${JSON.stringify({ id, ok: true, result: { satisfied: true }, _meta: { runtimeId: 'runtime-1' } })}\n`
    )

    expect(await response).toMatchObject({
      response: { ok: true, result: { satisfied: true } }
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects promptly when the runtime closes the socket before responding', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-transport-'))
    roots.push(userDataPath)
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => socket.end())
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))

    const metadata: RuntimeMetadata = {
      runtimeId: 'runtime-1',
      pid: 123,
      transports: [{ kind: 'unix', endpoint }],
      authToken: 'token',
      startedAt: 1
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const response = sendRequest(metadata, 'status.get', undefined, 60000).catch(
      (error: unknown) => error
    )
    await once(requestSocket(), 'close')
    await vi.runAllTimersAsync()
    expect(await response).toMatchObject({
      code: 'runtime_unavailable',
      message: 'Orca closed the connection before responding.'
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
