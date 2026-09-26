import { connect, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import { loadRelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture() {
  const database: RelayDatabase = {
    query: vi.fn(async () => []),
    queryLocked: vi.fn(async () => []),
    transaction: (operation) => operation(database),
    close: async () => {}
  }
  const config = loadRelayConfig({
    ORCA_RELAY_PUBLIC_URL: 'http://127.0.0.1',
    ORCA_RELAY_CELL_URL: 'http://127.0.0.1',
    ORCA_RELAY_AUTH_ISSUER: 'https://auth.example.test',
    ORCA_RELAY_JWKS_URL: 'https://auth.example.test/jwks',
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'synthetic-assignment-key-for-test-only',
    ORCA_RELAY_ROLE: 'cell',
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://auth.example.test/admin',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
    ORCA_RELAY_CELL_CONNECTION_HARD_CAP: '600',
    ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND: '60'
  })
  const relay = createRelayServer(config, database, {
    connectionLedgerLimits: { hardCap: 3, controlReserve: 1 }
  })
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  return { relay, port: address.port, database }
}

async function silentUpgrade(port: number, target: string): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  cleanups.push(() => {
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    let header = ''
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n` +
          'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          // RFC 6455 example nonce, matching the existing raw-upgrade fixture.
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
      )
    })
    const readHeader = (chunk: Buffer): void => {
      header += chunk.toString()
      if (!header.includes('\r\n\r\n')) return
      socket.off('data', readHeader)
      if (header.startsWith('HTTP/1.1 101 ')) resolve()
      else reject(new Error(header.split('\r\n')[0]))
    }
    socket.on('data', readHeader)
  })
  // This raw peer reads frames without answering the server's close handshake.
  socket.on('data', () => {})
  return socket
}

it.each([
  { label: 'first-frame timeout', target: '/v1/connect/abcdefghijklmnop', opcode: undefined },
  { label: 'binary first frame', target: '/v1/connect/abcdefghijklmnop', opcode: 0x82 },
  { label: 'invalid phone auth', target: '/v1/connect/abcdefghijklmnop', opcode: 0x81 },
  { label: 'invalid host-data auth', target: '/v1/host/data/connection-1', opcode: 0x81 }
])(
  'releases admission after $label even when the peer ignores close',
  async ({ target, opcode }) => {
    const { relay, port, database } = await fixture()
    const socket = await silentUpgrade(port, target)
    const firstFrameDeadline = opcode === undefined ? RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs : 0
    if (opcode !== undefined) socket.write(Buffer.from([opcode, 0x80, 0, 0, 0, 0]))
    await vi.waitFor(
      () => {
        expect(relay.connectionSnapshot()).toMatchObject({
          physicalConnections: 0,
          inFlightConnections: 0,
          reservedConnectionUnits: 0,
          enforcedConnectionUnits: 0
        })
      },
      { timeout: firstFrameDeadline + 2_000 }
    )
    expect(relay.runtimeCounts().preAuthConnections).toBe(0)
    expect(database.query).not.toHaveBeenCalled()
    expect(database.queryLocked).not.toHaveBeenCalled()
    await silentUpgrade(port, '/v1/connect/abcdefghijklmnop')
    expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
  }
)
