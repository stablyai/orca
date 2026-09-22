import { createServer as createNetServer } from 'node:net'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

describe('relay first-frame failures', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  it('contains phone authentication failures and releases connection capacity', async () => {
    const port = await unusedPort()
    const relayUrl = `http://127.0.0.1:${port}`
    const poolTimeout = new Error('injected pool connection timeout')
    const database: RelayDatabase = {
      query: vi.fn(async () => {
        throw poolTimeout
      }),
      queryLocked: vi.fn(async () => {
        throw poolTimeout
      }),
      transaction: vi.fn(async (operation) => await operation(database)),
      close: vi.fn(async () => undefined)
    }
    const config = {
      port,
      publicUrl: relayUrl,
      cellUrl: relayUrl,
      authIssuer: 'https://auth.example.com',
      authAudience: 'orca-relay',
      jwksUrl: 'https://auth.example.com/jwks',
      assignmentSigningKey: new Uint8Array(32),
      role: 'cell',
      cellId: 'production-gce-c3',
      cells: [{ id: 'production-gce-c3', url: relayUrl, capacityRequests: 4_000 }],
      adminAudience: `${relayUrl}/admin`,
      deployServiceAccount: 'deploy@example.com',
      runtimeServiceAccount: 'runtime@example.com',
      connectionHardCap: 600,
      connectionUnobservedBound: 60,
      adminJwksUrl: 'https://auth.example.com/admin-jwks',
      databasePoolMax: 10,
      publicAssignmentsEnabled: true,
      publicAssignmentConcurrency: 2,
      publicAssignmentQueueMax: 128,
      publicAssignmentWaitMs: 4_000,
      publicResolveConcurrency: 1,
      publicResolveWaitMs: 5_000,
      publicAssignmentRetryAfterSeconds: 5,
      dataDir: './test-data'
    } satisfies RelayConfig
    const relay = createRelayServer(config, database, {
      connectionLedgerLimits: { hardCap: 5, controlReserve: 1 }
    })
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    cleanup.push(() => {
      process.off('unhandledRejection', onUnhandled)
    })

    const socket = await openSocket(
      `${relayUrl.replace('http:', 'ws:')}/v1/connect/abcdefghijklmnop`
    )
    cleanup.push(() => socket.terminate())
    expect(relay.connectionSnapshot()).toMatchObject({
      physicalConnections: 1,
      reservedConnectionUnits: 1,
      enforcedConnectionUnits: 2
    })
    const closed = new Promise<number>((resolve) =>
      socket.once('close', (code) => resolve(code))
    )
    socket.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: Buffer.alloc(32, 1).toString('base64url')
      })
    )

    expect(await closed).toBe(RELAY_CLOSE_CODE.LIMIT_EXCEEDED)
    await vi.waitFor(() =>
      expect(relay.connectionSnapshot()).toMatchObject({
        physicalConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0
      })
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])
  })
})
