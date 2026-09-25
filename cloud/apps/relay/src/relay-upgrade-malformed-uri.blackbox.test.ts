import { connect, createServer as createNetServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function rawUpgrade(port: number, target: string): Promise<{ status: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let data = ''
    socket.once('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
          'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          // RFC 6455 §1.3 example nonce; allowlisted in cloud/.gitleaks.toml.
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      )
    })
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.once('close', () => resolve({ status: data.split('\r\n')[0] ?? '', closed: true }))
    socket.once('error', reject)
    setTimeout(() => {
      socket.destroy()
      resolve({ status: data.split('\r\n')[0] ?? '', closed: false })
    }, 1_500).unref()
  })
}

describe('relay upgrade with a malformed request target', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  it('rejects an undecodable /v1/connect path without an uncaught exception', async () => {
    const port = await unusedPort()
    const relayUrl = `http://127.0.0.1:${port}`
    const database: RelayDatabase = {
      query: vi.fn(async () => []),
      queryLocked: vi.fn(async () => []),
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

    // Vitest installs its own uncaughtException listener; capture ours first so the test reports
    // the exception as a verdict instead of dying with it.
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => {
      uncaught.push(error)
    }
    process.prependListener('uncaughtException', onUncaught)
    cleanup.push(() => {
      process.off('uncaughtException', onUncaught)
    })

    const results = []
    for (const target of [
      '/v1/connect/%',
      '/v1/connect/%E0%A4%A',
      '/v1/connect/%C0%AF',
      '/v1/host/data/%'
    ]) {
      results.push(await rawUpgrade(port, target))
    }
    // A malformed percent-escape must be a client error, never a process-level throw.
    expect(uncaught).toEqual([])
    for (const result of results) {
      expect(result.status).toMatch(/^HTTP\/1\.1 4\d\d/)
    }
    // The server must still serve a well-formed upgrade afterwards.
    const after = await rawUpgrade(port, '/v1/connect/abcdefghijklmnop')
    expect(after.status).toMatch(/^HTTP\/1\.1 101/)
  })
})
