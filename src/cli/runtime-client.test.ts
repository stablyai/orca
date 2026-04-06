/* eslint-disable max-lines -- Why: this test keeps the runtime bootstrap recovery matrix together so stale-pointer, recovery, and status semantics regressions are reviewed in one place. */
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Socket } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeRecordPath } from '../shared/runtime-bootstrap'
import { RuntimeClient, RuntimeRpcFailureError } from './runtime-client'

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
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
})

function writeMetadata(userDataPath: string, endpoint: string, authToken = 'token'): void {
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid: 123,
      transport: {
        kind: 'unix',
        endpoint
      },
      authToken,
      startedAt: 1
    }),
    'utf8'
  )
}

function writeRuntimeRecord(
  userDataPath: string,
  runtimeId: string,
  endpoint: string,
  authToken = 'token',
  startedAt = 1,
  pid = 123
): void {
  writeFileSync(
    getRuntimeRecordPath(userDataPath, runtimeId),
    JSON.stringify({
      runtimeId,
      pid,
      transport: {
        kind: 'unix',
        endpoint
      },
      authToken,
      startedAt
    }),
    'utf8'
  )
}

describe('RuntimeClient', () => {
  it('returns the full RPC envelope for successful calls', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { running: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 500)
    const response = await client.call<{ running: boolean }>('status.get')

    expect(response).toMatchObject({
      ok: true,
      result: { running: true },
      _meta: { runtimeId: 'runtime-1' }
    })
    expect(response.id).toBeTruthy()
  })

  it('reports not_running when no runtime metadata exists', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const client = new RuntimeClient(userDataPath, 100)

    const status = await client.getCliStatus()

    expect(status.result).toEqual({
      app: {
        running: false,
        pid: null
      },
      runtime: {
        state: 'not_running',
        reachable: false,
        runtimeId: null
      },
      graph: {
        state: 'not_running'
      }
    })
  })

  it('reports stale_bootstrap when bootstrap artifacts exist but no runtime is reachable', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    writeMetadata(userDataPath, join(userDataPath, 'missing.sock'))

    const client = new RuntimeClient(userDataPath, 100)
    const status = await client.getCliStatus()

    expect(status.result.runtime.state).toBe('stale_bootstrap')
    expect(status.result.runtime.reachable).toBe(false)
  })

  it('reports graph_not_ready when the runtime is reachable but graph is unavailable', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              rendererGraphEpoch: 0,
              graphStatus: 'unavailable',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0
            },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)
    const status = await client.getCliStatus()

    expect(status.result.runtime.state).toBe('graph_not_ready')
    expect(status.result.graph.state).toBe('unavailable')
  })

  it('openOrca succeeds immediately when the runtime is already reachable', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 1,
              liveLeafCount: 1
            },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)
    const status = await client.openOrca(100)

    expect(status.result.runtime.state).toBe('ready')
    expect(status.result.runtime.reachable).toBe(true)
  })

  it('recovers from stale primary metadata by probing per-runtime records', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const staleEndpoint = join(userDataPath, 'stale.sock')
    const liveEndpoint = join(userDataPath, 'live.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string; authToken: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-2',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 1,
              liveLeafCount: 1
            },
            _meta: { runtimeId: 'runtime-2' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(liveEndpoint, resolve))
    writeMetadata(userDataPath, staleEndpoint, 'stale-token')
    writeRuntimeRecord(userDataPath, 'runtime-2', liveEndpoint, 'live-token', 2, process.pid)

    const client = new RuntimeClient(userDataPath, 100)
    const status = await client.getCliStatus()

    expect(status.result.runtime.state).toBe('ready')
    expect(status.result.runtime.runtimeId).toBe('runtime-2')
  })

  it('openOrca returns the recovered runtime without launching a new app', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const staleEndpoint = join(userDataPath, 'stale.sock')
    const liveEndpoint = join(userDataPath, 'live.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-3',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 1,
              liveLeafCount: 1
            },
            _meta: { runtimeId: 'runtime-3' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(liveEndpoint, resolve))
    writeMetadata(userDataPath, staleEndpoint, 'stale-token')
    writeRuntimeRecord(userDataPath, 'runtime-3', liveEndpoint, 'live-token', 3, process.pid)

    const client = new RuntimeClient(userDataPath, 100)
    const status = await client.openOrca(100)

    expect(status.result.runtime.state).toBe('ready')
    expect(status.result.runtime.runtimeId).toBe('runtime-3')
  })

  it('times out if the runtime never responds', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      // Why: keep the socket open without replying so the client timeout path
      // is exercised against a real hung runtime connection.
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 25)

    await expect(client.call('status.get')).rejects.toMatchObject({
      code: 'runtime_timeout'
    })
  })

  it('allows a per-call timeout override for long runtime requests', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        setTimeout(() => {
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: { satisfied: true },
              _meta: { runtimeId: 'runtime-1' }
            })}\n`
          )
        }, 40)
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 25)
    const response = await client.call<{ satisfied: boolean }>('terminal.wait', undefined, {
      timeoutMs: 250
    })

    expect(response.result).toEqual({ satisfied: true })
  })

  it('preserves structured runtime failures', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'selector_not_found', message: 'selector_not_found' },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)

    await expect(client.call('worktree.show')).rejects.toBeInstanceOf(RuntimeRpcFailureError)
    await expect(client.call('worktree.show')).rejects.toMatchObject({
      response: {
        ok: false,
        _meta: { runtimeId: 'runtime-1' }
      }
    })
  })

  it('rejects invalid runtime response frames', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => {
        socket.write('not json\n')
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)

    await expect(client.call('status.get')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })

  it('rejects mismatched response ids from the runtime', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', () => {
        socket.write(
          `${JSON.stringify({
            id: 'not-the-request-id',
            ok: true,
            result: { running: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 100)

    await expect(client.call('status.get')).rejects.toMatchObject({
      code: 'invalid_runtime_response'
    })
  })
})
