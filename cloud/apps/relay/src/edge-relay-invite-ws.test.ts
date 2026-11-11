import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract/close-codes'
import { loadRelayConfig } from './config.js'
import type { RelayDatabase } from './database/database.js'
import { EDGE_CELL_ID, EdgeAssignments } from './edge-relay.js'
import { createRelayServer } from './relay-server.js'

const EDGE_URL = 'https://edge.relay.example.test'
const HOST = 'abcdefghijklmnop'
// A 43-character base64url credential is the shortest value RelayAuthSchema accepts.
const CREDENTIAL = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  const pending = cleanups.splice(0)
  for (let index = pending.length - 1; index >= 0; index -= 1) { await pending[index]!() }
  vi.restoreAllMocks()
})

async function director() {
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
    ORCA_RELAY_ROLE: 'director',
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://auth.example.test/admin',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.test',
    ORCA_RELAY_CELLS_JSON: JSON.stringify([
      { id: 'cell-1', url: 'https://cell-1.example.test', capacityRequests: 900 }
    ]),
    ORCA_RELAY_EDGE_CELL_URL: EDGE_URL,
    ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY: 'edge-admin-key-with-at-least-32-bytes!!'
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const relay = createRelayServer(config, database)
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
  const address = relay.server.address()
  if (!address || typeof address === 'string') { throw new Error('missing test port') }
  return { relay, port: address.port }
}

// A phone's invite socket on the director: answers relay-moved, then closes DRAINING.
async function inviteMove(port: number): Promise<{ messages: unknown[]; code: number }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/connect/${HOST}`)
  cleanups.push(() => socket.terminate())
  const messages: unknown[] = []
  socket.on('message', (data) => messages.push(JSON.parse(String(data))))
  socket.once('open', () =>
    socket.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: CREDENTIAL }))
  )
  const code = await new Promise<number>((resolve) => socket.once('close', (closeCode) => resolve(closeCode)))
  return { messages, code }
}

it('moves an invite of a host on the relay edge to the edge, never asking the cell paths', async () => {
  const { relay, port } = await director()
  const identity = { userId: 'user-1', relayHostId: HOST }
  vi.spyOn(relay.store, 'resolveInviteForMove').mockResolvedValue({ ...identity, relayDeviceId: 'device-1' })
  const onEdge = vi.spyOn(EdgeAssignments.prototype, 'edgeAssignment').mockResolvedValue({
    ...identity,
    cellId: EDGE_CELL_ID,
    cellUrl: EDGE_URL,
    assignmentEpoch: 7,
    leaseExpiresAt: Date.now() + 60_000
  })
  const resolve = vi.spyOn(relay.assignments, 'resolve')
  const assign = vi.spyOn(relay.assignments, 'assign')
  const { messages, code } = await inviteMove(port)
  expect(onEdge).toHaveBeenCalledWith(identity)
  expect(messages).toEqual([{ type: 'relay-moved', v: 1, cellUrl: EDGE_URL, assignmentEpoch: 7 }])
  expect(code).toBe(RELAY_CLOSE_CODE.DRAINING)
  expect(resolve).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})
