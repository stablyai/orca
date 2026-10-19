import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  buildHostProofMacInput,
  HostChallengeSchema,
  HOST_CHALLENGE_PLAINTEXT_DOMAIN
} from '@orca-cloud/relay-contract'
import nacl from 'tweetnacl'
import { expect, vi, type Mock, type MockInstance } from 'vitest'
import type WebSocket from 'ws'
import { RelayAssignmentStore } from '../assignment-store.js'
import { loadRelayConfig } from '../config.js'
import { RelayCredentialStore } from '../credential-store.js'
import type { RelayDatabase } from '../database.js'
import { HostSessionRegistry } from '../host-session-registry.js'
import type { RelayTokenClaims } from '../relay-token-verifier.js'
import { ProcessQueuedByteBudget } from '../splice-forwarder.js'

// A cell's host session registry over a stubbed database, driven through the real host hello
// and proof with fake sockets.

export class ProofSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn<(frame: string) => void>()
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(reason ?? ''))
  })

  peerClose(): void {
    this.readyState = this.CLOSED
    this.emit('close', 1000, Buffer.alloc(0))
  }

  registrySocket(): WebSocket {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fake implements the registry's send, state, close and EventEmitter surface; no actual networking is invoked.
    return this as unknown as WebSocket
  }
}

export type HostControlProofFixture = {
  registry: HostSessionRegistry
  assignments: RelayAssignmentStore
  verify: MockInstance<RelayAssignmentStore['verifyCellAssignment']>
  activate: MockInstance<RelayAssignmentStore['activateControl']>
  recordAuth: Mock
  database: RelayDatabase
  identity: RelayTokenClaims
  keyPair: nacl.BoxKeyPair
  hello: string
}

export function hostControlProofFixture(
  verifyRelayToken: (token: string) => Promise<RelayTokenClaims | null> = async () => null
): HostControlProofFixture {
  const database: RelayDatabase = {
    query: vi.fn(async () => []),
    queryLocked: vi.fn(async () => []),
    transaction: (operation) => operation(database),
    close: async () => undefined
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
  const assignments = new RelayAssignmentStore(database)
  const verify = vi.spyOn(assignments, 'verifyCellAssignment').mockResolvedValue(true)
  const activate = vi.spyOn(assignments, 'activateControl').mockResolvedValue('control:1')
  vi.spyOn(assignments, 'markMigrationTargetRegistered').mockResolvedValue(true)
  const recordAuth = vi.fn()
  const registry = new HostSessionRegistry(
    config,
    verifyRelayToken,
    new RelayCredentialStore(database),
    assignments,
    new ProcessQueuedByteBudget(),
    {
      recordAuth,
      recordForwardedBytes: vi.fn(),
      recordHttp: vi.fn(),
      recordReconnect: vi.fn(),
      recordSql: vi.fn()
    }
  )
  const keyPair = nacl.box.keyPair()
  const identity = {
    sub: 'user-proof',
    prof: 'profile-proof',
    relayHostId: createHash('sha256').update(keyPair.publicKey).digest('base64url').slice(0, 16),
    purpose: 'host-control',
    exp: Math.floor(Date.now() / 1000) + 3600
  } satisfies RelayTokenClaims
  const hello = JSON.stringify({
    type: 'host-hello',
    v: 1,
    relayHostId: identity.relayHostId,
    assignmentEpoch: 1,
    hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
    appVersion: 'test'
  })
  return { registry, assignments, verify, activate, recordAuth, database, identity, keyPair, hello }
}

export async function openProof(
  h: HostControlProofFixture,
  socket = new ProofSocket(),
  identity: RelayTokenClaims = h.identity,
  hello: string = h.hello
) {
  h.registry.acceptControl(socket.registrySocket(), identity)
  socket.emit('message', Buffer.from(hello), false)
  await vi.advanceTimersByTimeAsync(0)
  expect(h.verify).toHaveBeenCalled()
  expect(socket.send).toHaveBeenCalledOnce()
  return socket
}

export function answerProof(socket: ProofSocket, keyPair: nacl.BoxKeyPair): void {
  const frame = socket.send.mock.calls[0]?.[0]
  if (frame === undefined) {
    throw new Error('missing challenge')
  }
  const parsed: unknown = JSON.parse(frame)
  if (parsed === null || typeof parsed !== 'object' || !('type' in parsed)) {
    throw new Error('invalid challenge frame')
  }
  const { type, ...fields } = parsed
  expect(type).toBe('host-challenge')
  const challenge = HostChallengeSchema.parse(fields)
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.relayEphemeralPublicKeyB64, 'base64'),
    keyPair.secretKey
  )
  if (plaintext === null) {
    throw new Error('challenge did not decrypt')
  }
  const domain = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
  expect(plaintext.subarray(0, domain.length)).toEqual(domain)
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domain.length,
    4
  ).getUint32(0, false)
  const transcriptStart = domain.length + 4
  const transcript = plaintext.subarray(transcriptStart, transcriptStart + transcriptLength)
  const secret = plaintext.subarray(transcriptStart + transcriptLength)
  const proofB64 = createHmac('sha256', secret)
    .update(buildHostProofMacInput(transcript))
    .digest('base64')
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'host-challenge-ack', challengeId: challenge.challengeId, proofB64 })
    ),
    false
  )
}
