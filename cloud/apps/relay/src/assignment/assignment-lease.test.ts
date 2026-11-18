import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  ASSIGNMENT_LEASE_AUDIENCE,
  assignmentLeaseKeyId,
  classifyAssignmentLease
} from './assignment-lease.js'

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
    expiresAt?: string | number
  } = {}
): Promise<string> {
  const kid = overrides.kid === undefined ? assignmentLeaseKeyId(KEY) : overrides.kid
  return await new SignJWT({
    purpose: 'cell-assignment',
    cellId: overrides.cellId ?? CELL_ID,
    cellUrl: 'https://c7.relay.example.test',
    assignmentEpoch: overrides.assignmentEpoch ?? 4,
    relayHostId: HOST.relayHostId
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
    expect(await classify('x'.repeat(5_000))).toBe('bad-signature')
    expect(await classify(await lease({ sub: 'user-2' }))).toBe('wrong-host')
    expect(await classify(await lease({ cellId: 'production-gce-c8' }))).toBe('wrong-cell')
    expect(await classify(await lease({ assignmentEpoch: 3 }))).toBe('epoch-behind')
    expect(await classify(await lease({ assignmentEpoch: 5 }))).toBe('epoch-ahead')
  })
})
