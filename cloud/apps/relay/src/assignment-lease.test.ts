import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { SignJWT } from 'jose'
import nacl from 'tweetnacl'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import {
  ASSIGNMENT_LEASE_AUDIENCE,
  assignmentLeaseKeyId,
  classifyAssignmentLease
} from './assignment-lease.js'
import { ASSIGNMENT_LEASE_SHADOW_EVENT, AssignmentLeaseShadow } from './assignment-lease-shadow.js'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { HostSessionRegistry } from './host-session-registry.js'
import type { RelayTokenClaims } from './relay-token-verifier.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

const KEY = new TextEncoder().encode('0123456789abcdef0123456789abcdef')
const OTHER_KEY = new TextEncoder().encode('fedcba9876543210fedcba9876543210')
const CELL_ID = 'production-gce-c7'
const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }

async function lease(
  overrides: {
    key?: Uint8Array
    kid?: string | null
    cellId?: string
    assignmentEpoch?: number
    sub?: string
    relayHostId?: string
    expiresAt?: string | number
  } = {}
): Promise<string> {
  const kid = overrides.kid === undefined ? assignmentLeaseKeyId(KEY) : overrides.kid
  return await new SignJWT({
    purpose: 'cell-assignment',
    cellId: overrides.cellId ?? CELL_ID,
    cellUrl: 'https://c7.relay.example.test',
    assignmentEpoch: overrides.assignmentEpoch ?? 4,
    relayHostId: overrides.relayHostId ?? HOST.relayHostId
  })
    .setProtectedHeader(kid === null ? { alg: 'HS256' } : { alg: 'HS256', kid })
    .setIssuer('https://relay.example.test')
    .setAudience(ASSIGNMENT_LEASE_AUDIENCE)
    .setSubject(overrides.sub ?? HOST.userId)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? '5m')
    .sign(overrides.key ?? KEY)
}

const classify = async (value: string | undefined, helloEpoch = 4) =>
  await classifyAssignmentLease({
    lease: value,
    key: KEY,
    cellId: CELL_ID,
    ...HOST,
    helloEpoch
  })

describe('assignment lease classification', () => {
  it('names the key by a short hash of it', () => {
    expect(assignmentLeaseKeyId(KEY)).toMatch(/^k1-[0-9a-f]{8}$/)
    expect(assignmentLeaseKeyId(KEY)).toBe(
      `k1-${createHash('sha256').update(KEY).digest('hex').slice(0, 8)}`
    )
    expect(assignmentLeaseKeyId(OTHER_KEY)).not.toBe(assignmentLeaseKeyId(KEY))
  })

  it('sorts every lease into one class', async () => {
    expect(await classify(undefined)).toBe('absent')
    expect(await classify(await lease())).toBe('valid')
    // Directors from before the key id sign with none.
    expect(await classify(await lease({ kid: null }))).toBe('valid')
    expect(await classify(await lease({ expiresAt: Math.floor(Date.now() / 1000) - 10 }))).toBe(
      'expired'
    )
    expect(await classify(await lease({ key: OTHER_KEY, kid: null }))).toBe('bad-signature')
    expect(await classify(await lease({ kid: assignmentLeaseKeyId(OTHER_KEY) }))).toBe(
      'bad-signature'
    )
    expect(await classify('not.a.jwt')).toBe('bad-signature')
    expect(await classify('x'.repeat(5_000))).toBe('bad-signature')
    expect(await classify(await lease({ sub: 'user-2' }))).toBe('wrong-host')
    expect(await classify(await lease({ cellId: 'production-gce-c8' }))).toBe('wrong-cell')
    expect(await classify(await lease({ assignmentEpoch: 3 }))).toBe('epoch-behind')
    expect(await classify(await lease({ assignmentEpoch: 5 }))).toBe('epoch-ahead')
  })
})

describe('assignment lease shadow', () => {
  it('does nothing while the switch is off', () => {
    const shadow = new AssignmentLeaseShadow({ enabled: () => false, key: KEY, cellId: CELL_ID })
    expect(shadow.check({ lease: undefined, ...HOST, helloEpoch: 4 })).toBeNull()
  })

  it('counts each class against the database answer and logs one line per window', async () => {
    let now = 0
    const log = vi.fn()
    const shadow = new AssignmentLeaseShadow({
      enabled: () => true,
      key: KEY,
      cellId: CELL_ID,
      now: () => now,
      log
    })
    const valid = await lease()
    const record = async (value: string | undefined, dbValid: boolean, dbReadMs: number) => {
      const check = shadow.check({ lease: value, ...HOST, helloEpoch: 4 })
      expect(check).not.toBeNull()
      if (check) shadow.record(check, dbValid, dbReadMs)
      await check
      await Promise.resolve()
    }
    await record(valid, true, 2)
    await record(valid, false, 4)
    await record(undefined, true, 6)
    expect(log).not.toHaveBeenCalled()
    now = 60_000
    await record(valid, true, 8)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: ASSIGNMENT_LEASE_SHADOW_EVENT,
      cellId: CELL_ID,
      windowMs: 60_000,
      classes: {
        agree: 2,
        disagree: 1,
        absent: 1,
        expired: 0,
        badSignature: 0,
        wrongHost: 0,
        wrongCell: 0,
        epochBehind: 0,
        epochAhead: 0
      },
      dbRefused: 1,
      dbReadMs: { samples: 4, p50: 4, p99: 8, max: 8 }
    })
  })
})

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  readonly send = vi.fn()
  readonly close = vi.fn((code?: number) => {
    this.readyState = this.CLOSED
    this.emit('close', code, Buffer.from(''))
  })
}

describe('host hello with the lease shadow on', () => {
  async function hello(input: { withLease: boolean; databaseSays: boolean }) {
    const keyPair = nacl.box.keyPair()
    const relayHostId = createHash('sha256')
      .update(keyPair.publicKey)
      .digest('base64url')
      .slice(0, 16)
    const identity: RelayTokenClaims = {
      sub: HOST.userId,
      prof: 'profile-1',
      relayHostId,
      purpose: 'host-control',
      exp: 4_102_444_800
    }
    const recorded: string[] = []
    const shadow = new AssignmentLeaseShadow({ enabled: () => true, key: KEY, cellId: CELL_ID })
    const record = shadow.record.bind(shadow)
    vi.spyOn(shadow, 'record').mockImplementation((check, dbValid, dbReadMs) => {
      void check.then((leaseClass) => recorded.push(`${leaseClass}:${dbValid}`))
      record(check, dbValid, dbReadMs)
    })
    const verifyCellAssignment = vi.fn(async () => input.databaseSays)
    const registry = new HostSessionRegistry(
      config(),
      vi.fn(),
      {} as RelayCredentialStore,
      { verifyCellAssignment } as unknown as RelayAssignmentStore,
      new ProcessQueuedByteBudget(),
      { recordAuth: vi.fn(), recordForwardedBytes: vi.fn(), recordHttp: vi.fn(), recordReconnect: vi.fn(), recordSql: vi.fn() },
      Date.now,
      Math.random,
      'incarnation-1',
      shadow
    )
    const socket = new FakeSocket()
    const hostLease = input.withLease ? await lease({ relayHostId }) : undefined
    registry.acceptControl(socket as unknown as WebSocket, identity, undefined, undefined, hostLease)
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId,
          assignmentEpoch: 4,
          hostPublicKeyB64: Buffer.from(keyPair.publicKey).toString('base64'),
          appVersion: '1.4.200'
        })
      ),
      false
    )
    await vi.waitFor(() => expect(recorded).toHaveLength(1))
    return { socket, recorded, verifyCellAssignment }
  }

  it('still refuses a host the database refuses, whatever its lease says', async () => {
    const { socket, recorded } = await hello({ withLease: true, databaseSays: false })
    expect(socket.close).toHaveBeenCalledWith(RELAY_CLOSE_CODE.WRONG_CELL, 'wrong assignment epoch')
    expect(recorded).toEqual(['valid:false'])
  })

  it('still admits a host the database admits, with no lease at all', async () => {
    const { socket, recorded, verifyCellAssignment } = await hello({
      withLease: false,
      databaseSays: true
    })
    expect(verifyCellAssignment).toHaveBeenCalledTimes(1)
    expect(socket.close).not.toHaveBeenCalled()
    expect(String(socket.send.mock.calls[0]?.[0])).toContain('"type":"host-challenge"')
    expect(recorded).toEqual(['absent:true'])
  })
})

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://c7.relay.example.test',
    cellUrl: 'https://c7.relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: KEY,
    role: 'cell',
    cellId: CELL_ID,
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'relay-cell@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 10,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}
