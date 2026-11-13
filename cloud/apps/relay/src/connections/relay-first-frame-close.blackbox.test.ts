import { connect, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract/close-codes'
import { loadRelayConfig } from '../config.js'
import type { RelayDatabase } from '../database/database.js'
import { createRelayServer } from '../relay-server.js'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

const IDLE_LEDGER = {
  physicalConnections: 0,
  inFlightConnections: 0,
  reservedConnectionUnits: 0,
  enforcedConnectionUnits: 0
}

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
  return { relay, port: address.port }
}

type RawPeer = {
  socket: Socket
  received: () => Buffer
  transport: () => { ended: boolean; error: string | null }
}

async function silentUpgrade(port: number, target: string): Promise<RawPeer> {
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
  socket.removeAllListeners('error')
  // This raw peer reads frames without answering the server's close handshake.
  const chunks: Buffer[] = []
  let ended = false
  let error: string | null = null
  socket.on('data', (chunk: Buffer) => chunks.push(chunk))
  socket.on('end', () => {
    ended = true
  })
  socket.on('error', (caught: Error) => {
    error = caught.message
  })
  return {
    socket,
    received: () => Buffer.concat(chunks),
    transport: () => ({ ended, error })
  }
}

function maskedTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]!))
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked])
}

// Rejected peer’s last unmasked frame: 0x88, length, big-endian status, then UTF-8 reason.
function readCloseFrame(received: Buffer): { code: number; reason: string } | null {
  const start = received.lastIndexOf(0x88)
  if (start < 0 || received.length < start + 4) return null
  const length = received[start + 1]!
  return {
    code: received.readUInt16BE(start + 2),
    reason: received.subarray(start + 4, start + 2 + length).toString('utf8')
  }
}

async function expectIdleLedger(
  relay: Awaited<ReturnType<typeof fixture>>['relay'],
  timeout: number
): Promise<void> {
  await vi.waitFor(() => expect(relay.connectionSnapshot()).toMatchObject(IDLE_LEDGER), { timeout })
}

const PHONE_TARGET = '/v1/connect/abcdefghijklmnop'

it('releases admission after a binary first frame even when the peer ignores close', async () => {
  const { relay, port } = await fixture()
  const peer = await silentUpgrade(port, PHONE_TARGET)
  peer.socket.write(Buffer.from([0x82, 0x80, 0, 0, 0, 0]))
  await expectIdleLedger(relay, 2_000)
  expect(relay.runtimeCounts().preAuthConnections).toBe(0)
  await silentUpgrade(port, PHONE_TARGET)
  expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
})

// This responsive peer proves close bytes precede FIN, not delivery under backpressure: terminate can drop queued frames after 1s.
it('delivers the rejection code and a graceful FIN to a peer that keeps reading', async () => {
  const { relay, port } = await fixture()
  const peer = await silentUpgrade(port, PHONE_TARGET)
  peer.socket.write(maskedTextFrame(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'wrong' })))
  await vi.waitFor(() => expect(peer.transport().ended).toBe(true), { timeout: 3_000 })
  expect(peer.received().toString('utf8')).toContain('"code":4401')
  expect(readCloseFrame(peer.received())).toEqual({
    code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
    reason: 'invalid relay auth'
  })
  expect(peer.transport().error).toBeNull()
  await expectIdleLedger(relay, 2_000)
})
