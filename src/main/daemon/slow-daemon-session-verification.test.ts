import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { healthCheckDaemon } from './daemon-health'
import type { ListSessionsResult } from './types'
import type { SubprocessHandle } from './session'

// Why: terminals were lost after app updates because a busy machine could
// time out the 3s startup health check against a daemon that was alive and
// owning sessions, and the unhealthy path killed it. The fix re-verifies
// with listSessions, which has far larger budgets (5s hello, 30s request).
// This test reproduces the production asymmetry against a REAL daemon by
// inserting a response delay that exceeds the health-check budget but fits
// the verification budgets, and asserts the guard's two inputs disagree the
// way the fix depends on.
const RESPONSE_DELAY_MS = 3_500

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    dispose: vi.fn()
  }
}

/** Forwards client bytes to the daemon immediately, but delays every daemon
 *  response so each round-trip looks like a daemon under heavy load. */
function startDelayProxy(listenPath: string, upstreamPath: string): Server {
  const proxy = createServer((clientSocket: Socket) => {
    const upstream = connect(upstreamPath)
    clientSocket.on('data', (chunk) => upstream.write(chunk))
    upstream.on('data', (chunk) => {
      setTimeout(() => {
        if (!clientSocket.destroyed) {
          clientSocket.write(chunk)
        }
      }, RESPONSE_DELAY_MS)
    })
    const teardown = (): void => {
      clientSocket.destroy()
      upstream.destroy()
    }
    clientSocket.on('close', teardown)
    clientSocket.on('error', teardown)
    upstream.on('close', () => {
      setTimeout(teardown, RESPONSE_DELAY_MS)
    })
    upstream.on('error', teardown)
  })
  proxy.listen(listenPath)
  return proxy
}

describe('slow daemon session verification', () => {
  let dir: string
  let daemonSocketPath: string
  let proxySocketPath: string
  let tokenPath: string
  let server: DaemonServer
  let proxy: Server
  const clients: DaemonClient[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-slow-verification-test-'))
    daemonSocketPath = join(dir, 'daemon.sock')
    proxySocketPath = join(dir, 'proxy.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect()
    }
    await new Promise<void>((resolve) => proxy?.close(() => resolve()))
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it(
    'fails the 3s health check against a slow daemon while listSessions still verifies its live session',
    { timeout: 60_000 },
    async () => {
      server = new DaemonServer({
        socketPath: daemonSocketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()

      const directClient = new DaemonClient({ socketPath: daemonSocketPath, tokenPath })
      clients.push(directClient)
      await directClient.ensureConnected()
      await directClient.request('createOrAttach', {
        sessionId: 'wt-1@@live-session',
        cols: 80,
        rows: 24
      })

      proxy = startDelayProxy(proxySocketPath, daemonSocketPath)

      // The exact pre-fix kill trigger: the daemon is alive but too slow for
      // the health-check budget.
      await expect(healthCheckDaemon(proxySocketPath, tokenPath)).resolves.toBe(false)

      // The fix's re-verification against the SAME slow daemon: the larger
      // client budgets absorb the latency and prove the session is alive.
      const verificationClient = new DaemonClient({ socketPath: proxySocketPath, tokenPath })
      clients.push(verificationClient)
      await verificationClient.ensureConnected()
      const result = await verificationClient.request<ListSessionsResult>('listSessions', undefined)
      const liveSessionCount = result.sessions.filter((session) => session.isAlive).length
      expect(liveSessionCount).toBe(1)
    }
  )
})
