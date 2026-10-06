import { connect, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { RELAY_CLOSE_CODE, RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import { loadRelayConfig } from './config.js'
import type { RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'

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

async function fixture(
  options: { role?: 'cell' | 'director'; hardCap?: number } = {}
) {
  const role = options.role ?? 'cell'
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
    ORCA_RELAY_ROLE: role,
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://auth.example.test/admin',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
    ORCA_RELAY_CELL_CONNECTION_HARD_CAP: '600',
    ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND: '60',
    ...(role === 'director'
      ? {
          ORCA_RELAY_CELLS_JSON: JSON.stringify([
            { id: 'cell-1', url: 'https://cell-1.example.test', capacityRequests: 900 }
          ])
        }
      : {})
  })
  const relay = createRelayServer(config, database, {
    connectionLedgerLimits: { hardCap: options.hardCap ?? 3, controlReserve: 1 }
  })
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  return { relay, port: address.port, database }
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

// A 43-character base64url credential is the shortest value RelayAuthSchema accepts.
const WELL_FORMED_CREDENTIAL = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

function maskedTextFrame(payload: string): Buffer {
  const body = Buffer.from(payload)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]!))
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked])
}

function relayAuthFrame(): Buffer {
  return maskedTextFrame(
    JSON.stringify({
      type: 'relay-auth',
      v: 1,
      mode: 'connect',
      credential: WELL_FORMED_CREDENTIAL
    })
  )
}

// The close frame is the last unmasked frame a rejected peer receives: 0x88, length,
// then a big-endian status code followed by the UTF-8 reason.
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

it.each([
  { label: 'first-frame timeout', target: PHONE_TARGET, opcode: undefined },
  { label: 'binary first frame', target: PHONE_TARGET, opcode: 0x82 },
  { label: 'invalid phone auth', target: PHONE_TARGET, opcode: 0x81 },
  { label: 'invalid host-data auth', target: '/v1/host/data/connection-1', opcode: 0x81 }
])(
  'releases admission after $label even when the peer ignores close',
  async ({ target, opcode }) => {
    const { relay, port, database } = await fixture()
    const peer = await silentUpgrade(port, target)
    const firstFrameDeadline = opcode === undefined ? RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs : 0
    if (opcode !== undefined) peer.socket.write(Buffer.from([opcode, 0x80, 0, 0, 0, 0]))
    await expectIdleLedger(relay, firstFrameDeadline + 2_000)
    expect(relay.runtimeCounts().preAuthConnections).toBe(0)
    expect(database.query).not.toHaveBeenCalled()
    expect(database.queryLocked).not.toHaveBeenCalled()
    await silentUpgrade(port, PHONE_TARGET)
    expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
  }
)

it('releases admission after a rejected director invite when the peer ignores close', async () => {
  const { relay, port } = await fixture({ role: 'director' })
  const peer = await silentUpgrade(port, PHONE_TARGET)
  peer.socket.write(relayAuthFrame())
  await expectIdleLedger(relay, 2_000)
  expect(readCloseFrame(peer.received())).toEqual({
    code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
    reason: 'invalid invite'
  })
  expect(relay.runtimeCounts().preAuthConnections).toBe(0)
  await silentUpgrade(port, PHONE_TARGET)
  expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
})

it('releases admission after a director move redirect when the peer ignores close', async () => {
  const { relay, port } = await fixture({ role: 'director' })
  const identity = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
  vi.spyOn(relay.store, 'resolveInviteForMove').mockResolvedValue({
    userId: identity.userId,
    relayDeviceId: 'device-1'
  })
  vi.spyOn(relay.assignments, 'resolve').mockResolvedValue({
    ...identity,
    cellId: 'cell-1',
    cellUrl: 'https://cell-1.example.test',
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 60_000
  })
  const peer = await silentUpgrade(port, PHONE_TARGET)
  peer.socket.write(relayAuthFrame())
  await expectIdleLedger(relay, 2_000)
  expect(peer.received().toString('utf8')).toContain('"type":"relay-moved"')
  expect(readCloseFrame(peer.received())).toEqual({
    code: RELAY_CLOSE_CODE.DRAINING,
    reason: 'connect to assigned cell'
  })
  await silentUpgrade(port, PHONE_TARGET)
  expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
})

// A peer that keeps draining its socket does get the rejection: the close frame is written
// before the force-close timer can fire, and TCP delivers those bytes ahead of the FIN.
//
// Scope, deliberately narrow: this peer reads every byte as it arrives, so the assertion below
// speaks only for a responsive peer. It is not evidence that delivery survives backpressure —
// `terminate()` destroys the socket a second later, and a frame still queued in the kernel or in
// `ws`'s own buffer goes unsent. Treat the rejection as best effort; the bound on the close is
// what the trade-off actually buys.
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

const BINARY_FIRST_FRAME = Buffer.from([0x82, 0x80, 0, 0, 0, 0])
// maxPreAuthPerSource caps how many unauthenticated sockets one source may hold at once.
const CONCURRENT_PEERS_PER_SOURCE = 4

it('returns capacity to its exact baseline after repeated bursts of rejections', async () => {
  const { relay, port } = await fixture({ hardCap: 2 * CONCURRENT_PEERS_PER_SOURCE + 1 })
  for (let wave = 0; wave < 3; wave++) {
    const peers = await Promise.all(
      Array.from({ length: CONCURRENT_PEERS_PER_SOURCE }, () =>
        silentUpgrade(port, PHONE_TARGET)
      )
    )
    expect(relay.connectionSnapshot()).toMatchObject({
      enforcedConnectionUnits: 2 * CONCURRENT_PEERS_PER_SOURCE
    })
    for (const peer of peers) peer.socket.write(BINARY_FIRST_FRAME)
    await expectIdleLedger(relay, 3_000)
    expect(relay.runtimeCounts().preAuthConnections).toBe(0)
  }
})

// A rejection racing the peer's own disconnect must release once, not twice: the ledger
// does not clamp at zero, so a double release shows up as a negative count here.
it('releases exactly once when a rejected peer disconnects at the same moment', async () => {
  const { relay, port } = await fixture({ hardCap: 2 * CONCURRENT_PEERS_PER_SOURCE + 1 })
  const peers = await Promise.all(
    Array.from({ length: CONCURRENT_PEERS_PER_SOURCE }, () => silentUpgrade(port, PHONE_TARGET))
  )
  for (const peer of peers) {
    peer.socket.write(BINARY_FIRST_FRAME)
    peer.socket.destroy()
  }
  await expectIdleLedger(relay, 3_000)
  expect(relay.connectionSnapshot()).toMatchObject(IDLE_LEDGER)
  expect(relay.runtimeCounts().preAuthConnections).toBe(0)
  await silentUpgrade(port, PHONE_TARGET)
  expect(relay.connectionSnapshot()?.enforcedConnectionUnits).toBe(2)
})
