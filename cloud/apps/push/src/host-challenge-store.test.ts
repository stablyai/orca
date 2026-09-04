import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import { deriveHostFingerprint } from './host-fingerprint.js'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'

const GATEWAY_ORIGIN = 'https://push.onorca.dev'

describe('push host challenge store', () => {
  let database: PushDatabase
  let clock = 1_700_000_000_000
  let store: PushHostChallengeStore

  beforeEach(async () => {
    database = await openInMemoryPushDatabase()
    clock = 1_700_000_000_000
    store = new PushHostChallengeStore(database, GATEWAY_ORIGIN, () => clock)
  })

  afterEach(async () => {
    await database.close()
  })

  it('completes a challenge, proof, and consume round trip', async () => {
    const host = createPushHostKeypair(1)
    const challenge = await store.issue(hostPublicKeyB64(host))
    expect(challenge).not.toBeNull()
    expect(challenge!.expiresAt).toBe(clock + PUSH_LIMITS.challengeTtlMs)
    expect(challenge!.hostFingerprint).toBe(deriveHostFingerprint(host.publicKey))

    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })
    expect(proof).not.toBeNull()
    await expect(store.verify(challenge!.challengeId, proof!)).resolves.toEqual({
      ok: true,
      hostFingerprint: deriveHostFingerprint(host.publicKey)
    })
    const [hostRow] = await database.query('SELECT host_fingerprint, last_seen_at FROM push_hosts')
    expect(hostRow?.host_fingerprint).toBe(deriveHostFingerprint(host.publicKey))
  })

  it('never stores material that reproduces the proof', async () => {
    const host = createPushHostKeypair(2)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })
    const [row] = await database.query('SELECT secret_hash FROM push_challenges')
    expect(String(row?.secret_hash)).not.toBe(proof)
    expect(Buffer.from(String(row?.secret_hash), 'base64url').byteLength).toBe(32)
  })

  it('rejects a replayed challenge', async () => {
    const host = createPushHostKeypair(3)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toMatchObject({ ok: true })
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toEqual({
      ok: false,
      reason: 'already_consumed'
    })
  })

  it('rejects a challenge past its ttl plus the skew tolerance', async () => {
    const host = createPushHostKeypair(4)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    clock += PUSH_LIMITS.challengeTtlMs + PUSH_LIMITS.clockSkewToleranceMs + 1
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('still accepts a proof inside the skew tolerance', async () => {
    const host = createPushHostKeypair(5)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    clock += PUSH_LIMITS.challengeTtlMs + PUSH_LIMITS.clockSkewToleranceMs - 1
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toMatchObject({ ok: true })
  })

  it('refuses a wrong host: the box will not open and a foreign proof will not match', async () => {
    const owner = createPushHostKeypair(6)
    const intruder = createPushHostKeypair(7)
    const ownerChallenge = await store.issue(hostPublicKeyB64(owner))
    expect(
      answerPushHostChallenge(ownerChallenge!, {
        gatewayOrigin: GATEWAY_ORIGIN,
        keypair: intruder,
        now: () => clock
      })
    ).toBeNull()

    const intruderChallenge = await store.issue(hostPublicKeyB64(intruder))
    const intruderProof = answerPushHostChallenge(intruderChallenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: intruder,
      now: () => clock
    })!
    await expect(store.verify(ownerChallenge!.challengeId, intruderProof)).resolves.toEqual({
      ok: false,
      reason: 'proof_mismatch'
    })
  })

  it('rejects a proof bound to a different gateway origin', async () => {
    const host = createPushHostKeypair(8)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const reasons: string[] = []
    expect(
      answerPushHostChallenge(challenge!, {
        gatewayOrigin: 'https://push.example.test',
        keypair: host,
        now: () => clock,
        onInvalid: (reason) => reasons.push(reason)
      })
    ).toBeNull()
    expect(reasons.join()).toContain('gatewayOrigin')
  })

  it('rejects an unknown challenge id and a malformed public key', async () => {
    await expect(store.verify('missing', Buffer.alloc(32, 9).toString('base64'))).resolves.toEqual({
      ok: false,
      reason: 'unknown_challenge'
    })
    await expect(store.issue('not-base64!!')).resolves.toBeNull()
    await expect(store.issue(Buffer.alloc(31, 1).toString('base64'))).resolves.toBeNull()
  })

  it('prunes challenges that fell out of the skew window', async () => {
    const host = createPushHostKeypair(9)
    await store.issue(hostPublicKeyB64(host))
    expect(await store.pruneExpired()).toBe(0)
    clock += PUSH_LIMITS.challengeTtlMs + PUSH_LIMITS.clockSkewToleranceMs + 1
    expect(await store.pruneExpired()).toBe(1)
  })
})
