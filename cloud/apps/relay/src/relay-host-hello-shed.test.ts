import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayConfig } from './config.js'
import { PostgresDatabase } from './database.js'
import { HostSessionRegistry } from './host-session-registry.js'
import { createRelayServer, HOST_HELLO_SHED_OLDEST_WAIT_MS } from './relay-server.js'

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

// pg-pool's shape with every acquire stuck, so queued work only accumulates.
function stalledPool() {
  const pool = {
    options: { max: 2, connectionTimeoutMillis: 0 },
    totalCount: 2,
    idleCount: 0,
    waitingCount: 0,
    connect: () => {
      pool.waitingCount++
      return new Promise<never>(() => {})
    },
    end: async () => undefined
  }
  return pool
}

function cellConfig(port: number, issuer: string): RelayConfig {
  const relayUrl = `http://127.0.0.1:${port}`
  return {
    port,
    publicUrl: relayUrl,
    cellUrl: relayUrl,
    authIssuer: issuer,
    authAudience: 'orca-relay',
    jwksUrl: issuer,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c3',
    cells: [{ id: 'production-gce-c3', url: relayUrl, capacityRequests: 4_000 }],
    adminAudience: `${relayUrl}/admin`,
    deployServiceAccount: 'deploy@example.com',
    runtimeServiceAccount: 'runtime@example.com',
    connectionHardCap: 600,
    connectionUnobservedBound: 60,
    adminJwksUrl: `${issuer}/admin-jwks`,
    databasePoolMax: 2,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 1,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './test-data'
  }
}

describe('host hello shedding under database pool pressure', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  // A cell whose pool holds `waiters` stuck queries, and a clock the test moves.
  async function startCell(waiters: number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const keys = await generateKeyPair('ES256')
    const publicJwk = await exportJWK(keys.publicKey)
    const jwksServer: Server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] })
      )
    })
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => jwksServer.close(() => resolve())))
    const jwksAddress = jwksServer.address()
    if (!jwksAddress || typeof jwksAddress === 'string') throw new Error('missing JWKS address')
    const issuer = `http://127.0.0.1:${jwksAddress.port}`

    const realNow = Date.now()
    let elapsedMs = 0
    // Before the database exists, so the pool's wait clock reads it too.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + elapsedMs)
    const database = new PostgresDatabase(stalledPool() as never)
    for (let index = 0; index < waiters; index++) void database.query('SELECT 1').catch(() => {})
    const port = await unusedPort()
    const relay = createRelayServer(cellConfig(port, issuer), database)
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))

    const hostId = createHash('sha256')
      .update(nacl.box.keyPair().publicKey)
      .digest('base64url')
      .slice(0, 16)
    const token = await new SignJWT({
      prof: 'profile-1',
      org: 'org-1',
      purpose: 'host-control',
      relayHostId: hostId
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience('orca-relay')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey)
    return {
      url: `ws://127.0.0.1:${port}/v1/host/control`,
      token,
      advance: (ms: number) => {
        elapsedMs += ms
      }
    }
  }

  // Resolves with the refusal's status, or 101 once the upgrade is accepted.
  async function dial(
    cell: Awaited<ReturnType<typeof startCell>>
  ): Promise<{ status: number; retryAfter?: string }> {
    const socket = new WebSocket(cell.url, {
      headers: { authorization: `Bearer ${cell.token}` },
      perMessageDeflate: false
    })
    return await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (request, response) => {
        resolve({ status: response.statusCode ?? 0, retryAfter: response.headers['retry-after'] })
        request.destroy()
      })
      socket.once('open', () => {
        resolve({ status: 101 })
        socket.terminate()
      })
      socket.once('error', reject)
    })
  }

  it('admits hellos behind a deep queue that is still moving', async () => {
    const cell = await startCell(120)
    cell.advance(HOST_HELLO_SHED_OLDEST_WAIT_MS - 300)

    expect(await dial(cell)).toEqual({ status: 101 })
  })

  it('admits hellos behind one slow waiter', async () => {
    // The test pool holds 2 connections, so a lone aged waiter is under the count floor.
    const cell = await startCell(1)
    cell.advance(HOST_HELLO_SHED_OLDEST_WAIT_MS * 2)

    expect(await dial(cell)).toEqual({ status: 101 })
  })

  it('refuses a hello with a retryable 503 once a full queue has aged', async () => {
    const cell = await startCell(2)
    cell.advance(HOST_HELLO_SHED_OLDEST_WAIT_MS)

    expect(await dial(cell)).toEqual({ status: 503, retryAfter: '2' })
    // Shipped desktops dial with no unexpected-response listener, so the refusal
    // reaches them as the ordinary connect error their retry backoff handles.
    const desktop = new WebSocket(cell.url, {
      headers: { authorization: `Bearer ${cell.token}` }
    })
    const error = await new Promise<Error>((resolve) => desktop.once('error', resolve))
    expect(error.message).toBe('Unexpected server response: 503')
  })

  it('never refuses a rebind over a live control', async () => {
    vi.spyOn(HostSessionRegistry.prototype, 'hasActiveControl').mockReturnValue(true)
    const cell = await startCell(2)
    cell.advance(HOST_HELLO_SHED_OLDEST_WAIT_MS * 2)

    expect(await dial(cell)).toEqual({ status: 101 })
  })
})
