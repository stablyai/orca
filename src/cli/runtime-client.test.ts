import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'
import { launchOrcaApp } from './runtime/launch'

vi.mock('./runtime/launch', () => ({
  launchOrcaApp: vi.fn()
}))

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  vi.mocked(launchOrcaApp).mockClear()
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

function writeMetadata(
  userDataPath: string,
  endpoint: string,
  authToken = 'token',
  pid = 123
): void {
  writeFileSync(
    join(userDataPath, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid,
      transports: [
        {
          kind: 'unix',
          endpoint
        }
      ],
      authToken,
      startedAt: 1
    }),
    'utf8'
  )
}

function findUnusedPid(seed = 200_000): number {
  // Why: the stale-bootstrap test must point metadata at a definitely-dead
  // process. Hard-coding a small PID is host-dependent and flakes when that
  // PID happens to be alive on the machine running the suite.
  let pid = Math.max(seed, process.pid + 10_000)
  while (pid < 2_000_000) {
    try {
      process.kill(pid, 0)
      pid += 1
    } catch {
      return pid
    }
  }
  return 2_000_000
}

// Why: these tests create Unix domain socket servers in temp directories.
// Windows does not support Unix domain sockets in the same way, causing
// EACCES errors on listen(), so the suite is skipped on that platform.
describe.skipIf(process.platform === 'win32')('RuntimeClient', () => {
  it('adds an opaque durable request ID only to orchestration mutations', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const requests: Record<string, unknown>[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as Record<string, unknown>
        requests.push(request)
        const result =
          request.method === 'status.get'
            ? { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] }
            : {}
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result,
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const priorLaunchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-secret'
    const client = new RuntimeClient(userDataPath, 500)
    try {
      await client.call(
        'orchestration.send',
        { subject: 'hello' },
        {
          orchestrationRequestId: 'mutation_explicit'
        }
      )
      await client.call('orchestration.taskList', {})
      const secondClient = new RuntimeClient(userDataPath, 500)
      await secondClient.call('orchestration.taskList', {})
    } finally {
      if (priorLaunchToken === undefined) {
        delete process.env.ORCA_AGENT_LAUNCH_TOKEN
      } else {
        process.env.ORCA_AGENT_LAUNCH_TOKEN = priorLaunchToken
      }
    }

    expect(requests[0]?.method).toBe('status.get')
    expect(requests[0]?.compatibilityInvocationId).toBeUndefined()
    expect(requests[1]?.orchestrationRequestId).toBe('mutation_explicit')
    expect(requests[1]?.orchestrationContractVersion).toBe(1)
    expect(requests[1]?.compatibilityInvocationId).toBe('mutation_explicit')
    expect(requests[1]?.orchestrationCompatibilityEvidence).toMatchObject({
      launchToken: 'launch-secret'
    })
    expect(requests[2]?.orchestrationRequestId).toBeUndefined()
    expect(requests[2]?.compatibilityInvocationId).not.toBe(requests[1]?.compatibilityInvocationId)
    expect(requests[3]?.method).toBe('orchestration.taskList')
    expect(requests[3]?.compatibilityInvocationId).not.toBe(requests[1]?.compatibilityInvocationId)
  })

  it('rejects an old local runtime before sending an orchestration mutation', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const requests: Record<string, unknown>[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as Record<string, unknown>
        requests.push(request)
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { capabilities: [] },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)

    const client = new RuntimeClient(userDataPath, 500)
    await expect(client.call('orchestration.send', { subject: 'hello' })).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: {
        reason: 'runtime_capability_missing',
        effectsApplied: false,
        nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
      }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('status.get')
  })

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
      target: { kind: 'local' },
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
    writeMetadata(userDataPath, join(userDataPath, 'missing.sock'), 'token', findUnusedPid())

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

  it('openOrca activates the app even when a desktop runtime is already reachable', async () => {
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
    expect(launchOrcaApp).toHaveBeenCalledOnce()
  })

  // STA-3969: this loop only polls getCliStatus, so an unreachable runtime used to
  // burn the whole budget and then report a bare timeout — the third symptom in the
  // report, and the one that reads as "the app never finished starting".
  it('openOrca reports why the runtime was unreachable instead of a bare timeout', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    writeMetadata(userDataPath, join(userDataPath, 'never-listened.sock'), 'token', process.pid)

    const client = new RuntimeClient(userDataPath, 100)

    await expect(client.openOrca(100)).rejects.toMatchObject({
      code: 'runtime_open_timeout',
      message: expect.stringContaining('never-listened.sock'),
      data: { unreachableReason: { code: 'endpoint_missing' } }
    })
  })

  // STA-3969: the diagnosis is still worth surfacing once metadata disappears, but the newest
  // poll no longer observes it -- so it is reported as the last failure seen, not as the live
  // one. Presenting it under `unreachableReason` would be the same stale negative in machine form.
  it('reports the last unreachable reason as history when later polls have no metadata', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    writeMetadata(userDataPath, join(userDataPath, 'never-listened.sock'), 'token', process.pid)
    vi.mocked(launchOrcaApp).mockImplementationOnce(() => {
      rmSync(join(userDataPath, 'orca-runtime.json'))
    })

    const client = new RuntimeClient(userDataPath, 100)

    const failure = await client.openOrca(100).then(
      () => null,
      (error: unknown) => error as { code: string; message: string; data?: unknown }
    )
    expect(failure?.code).toBe('runtime_open_timeout')
    expect(failure?.message).toContain('never-listened.sock')
    expect(failure?.message).toContain('The last failure it reported was')
    expect(failure?.message).not.toContain('the Orca app process is running')
    const data = failure?.data as {
      unreachableReason?: unknown
      lastObservedUnreachableReason?: { code?: string }
    }
    expect(data.unreachableReason).toBeUndefined()
    expect(data.lastObservedUnreachableReason?.code).toBe('endpoint_missing')
  })

  // STA-3969: same stale negative one state further along -- the runtime was unreachable, then
  // its PROCESS exited. The newest poll reports a dead process and no reason, so quoting the old
  // endpoint failure claims a running process the latest status denies.
  it('openOrca stops claiming the process is running once it exits mid-wait', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'never-listened.sock')
    writeMetadata(userDataPath, endpoint, 'token', process.pid)
    vi.mocked(launchOrcaApp).mockImplementationOnce(() => {
      writeMetadata(userDataPath, endpoint, 'token', findUnusedPid())
    })

    const client = new RuntimeClient(userDataPath, 100)

    const failure = await client.openOrca(100).then(
      () => null,
      (error: unknown) => error as { code: string; message: string; data?: unknown }
    )
    expect(failure?.code).toBe('runtime_open_timeout')
    expect(failure?.message).not.toContain('the Orca app process is running')
    expect(failure?.message).toContain('no longer running')
    expect(
      (failure?.data as { unreachableReason?: unknown } | undefined)?.unreachableReason
    ).toBeUndefined()
  })

  // STA-3969: `request_rejected` means the runtime ANSWERED and refused. Calling that
  // "unreachable" contradicts the very reason being quoted alongside it.
  it('openOrca says the runtime refused the request instead of calling it unreachable', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: { code: 'status_refused', message: 'status.get is disabled' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint, 'token', process.pid)

    const client = new RuntimeClient(userDataPath, 100)

    const failure = await client.openOrca(100).then(
      () => null,
      (error: unknown) => error as { code: string; message: string; data?: unknown }
    )
    expect(failure?.code).toBe('runtime_open_timeout')
    expect(
      (failure?.data as { unreachableReason?: { code?: string } } | undefined)?.unreachableReason
        ?.code
    ).toBe('request_rejected')
    expect(failure?.message).toContain('refused the status request')
    expect(failure?.message).not.toContain('its runtime is unreachable')
  })

  // STA-3969: the poll carried the earlier reason forward with `?? lastReason`, so a runtime
  // that RECOVERED mid-wait was still reported unreachable at the timeout -- a stale negative
  // presented as the current diagnosis.
  it('openOrca stops reporting a runtime unreachable once it answers again', async () => {
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
              authoritativeWindowId: 0,
              desktopWindowStatus: 'initializing',
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
    // Starts pointed at an endpoint nothing serves, then recovers onto the live one.
    writeMetadata(userDataPath, join(userDataPath, 'never-listened.sock'), 'token', process.pid)
    vi.mocked(launchOrcaApp).mockImplementationOnce(() => {
      writeMetadata(userDataPath, endpoint, 'token', process.pid)
    })

    const client = new RuntimeClient(userDataPath, 100)

    const failure = await client.openOrca(1_000).then(
      () => null,
      (error: unknown) => error as { code: string; message: string; data?: unknown }
    )
    expect(failure?.code).toBe('runtime_open_timeout')
    expect(failure?.message).not.toContain('unreachable')
    expect(failure?.data).toBeUndefined()
    // The second timeout case: answers all the way through, just no window.
    expect(failure?.message).toContain('is responding and still running headlessly')
  })

  it('openOrca waits for a reachable headless runtime to expose a desktop window', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let statusRequests = 0
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        statusRequests += 1
        const available = statusRequests > 1
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              rendererGraphEpoch: available ? 1 : 0,
              graphStatus: available ? 'reloading' : 'ready',
              authoritativeWindowId: available ? 1 : 0,
              desktopWindowStatus: available ? 'available' : 'initializing',
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
    const status = await client.openOrca(1_000)

    expect(launchOrcaApp).toHaveBeenCalledOnce()
    expect(status.result.app.desktopWindowStatus).toBe('available')
    expect(statusRequests).toBeGreaterThan(1)
  })

  it('openOrca fails explicitly when the serve owner cannot promote safely', async () => {
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
              authoritativeWindowId: 0,
              desktopWindowStatus: 'blocked',
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

    await expect(client.openOrca(100)).rejects.toMatchObject({
      code: 'desktop_activation_blocked'
    })
    // A blocked runtime can't promote, so we bail before spawning the app.
    expect(launchOrcaApp).not.toHaveBeenCalled()
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

  it('preserves a dropped read-only orchestration failure exactly', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let request: Record<string, unknown> | undefined
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        request = JSON.parse(String(data).trim()) as Record<string, unknown>
        socket.end()
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeMetadata(userDataPath, endpoint)
    const client = new RuntimeClient(userDataPath, 100)

    const failure = await client
      .call('orchestration.workerShow', { dispatch: 'ctx_1' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RuntimeClientError)
    expect((failure as RuntimeClientError).message).toBe(
      'The Orca runtime closed the connection before responding. Restart Orca and try again.'
    )
    expect((failure as RuntimeClientError).data).toBeUndefined()
    expect(request).toMatchObject({ method: 'orchestration.workerShow' })
    expect(request).not.toHaveProperty('orchestrationRequestId')
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
