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

  it('rejects a challenge the moment its own ttl elapses', async () => {
    const host = createPushHostKeypair(4)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    clock += PUSH_LIMITS.challengeTtlMs + 1
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('spends no skew tolerance on its own expiry, so the ttl is the whole window', async () => {
    const host = createPushHostKeypair(5)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    // A proof that the host would still consider in-window is refused here: the
    // gateway issued expires_at against this clock and needs no allowance.
    clock += PUSH_LIMITS.challengeTtlMs + PUSH_LIMITS.clockSkewToleranceMs - 1
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('accepts a proof that lands just inside the ttl', async () => {
    const host = createPushHostKeypair(26)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    clock += PUSH_LIMITS.challengeTtlMs
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toMatchObject({ ok: true })
  })

  it('keeps an expired row long enough to answer expired rather than unknown', async () => {
    const host = createPushHostKeypair(27)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    clock += PUSH_LIMITS.challengeTtlMs + 1
    expect(await store.pruneExpired()).toBe(0)
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toEqual({
      ok: false,
      reason: 'expired'
    })
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

  it('creates no host row until a proof succeeds', async () => {
    const host = createPushHostKeypair(30)
    const challenge = await store.issue(hostPublicKeyB64(host))
    const [beforeProof] = await database.query('SELECT COUNT(*) AS hosts FROM push_hosts')
    expect(Number(beforeProof?.hosts)).toBe(0)

    const proof = answerPushHostChallenge(challenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: host,
      now: () => clock
    })!
    await expect(store.verify(challenge!.challengeId, proof)).resolves.toMatchObject({ ok: true })
    const [row] = await database.query('SELECT host_public_key, last_seen_at FROM push_hosts')
    expect(row?.host_public_key).toBe(hostPublicKeyB64(host))
    expect(Number(row?.last_seen_at)).toBe(clock)
  })

  it('leaves no host row behind when a challenge is never answered', async () => {
    for (let index = 0; index < 5; index++) {
      await store.issue(hostPublicKeyB64(createPushHostKeypair(40 + index)))
    }
    const [row] = await database.query('SELECT COUNT(*) AS hosts FROM push_hosts')
    expect(Number(row?.hosts)).toBe(0)
  })

  it('prunes a host past retention only when it has no registration left', async () => {
    const stale = createPushHostKeypair(50)
    const kept = createPushHostKeypair(51)
    for (const host of [stale, kept]) {
      const challenge = await store.issue(hostPublicKeyB64(host))
      const proof = answerPushHostChallenge(challenge!, {
        gatewayOrigin: GATEWAY_ORIGIN,
        keypair: host,
        now: () => clock
      })!
      await store.verify(challenge!.challengeId, proof)
    }
    await database.query(
      `INSERT INTO push_devices (registration_id, host_fingerprint, device_id, platform, token,
       filter_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['reg-1', deriveHostFingerprint(kept.publicKey), 'device-1', 'android', 'token', '{}', clock, clock]
    )

    clock += PUSH_LIMITS.hostRetentionMs
    expect(await store.pruneStaleHosts()).toBe(0)
    clock += 1
    expect(await store.pruneStaleHosts()).toBe(1)
    const [row] = await database.query('SELECT host_fingerprint FROM push_hosts')
    expect(row?.host_fingerprint).toBe(deriveHostFingerprint(kept.publicKey))
  })

  it('prunes challenges that fell out of the skew window', async () => {
    const host = createPushHostKeypair(9)
    await store.issue(hostPublicKeyB64(host))
    expect(await store.pruneExpired()).toBe(0)
    clock += PUSH_LIMITS.challengeTtlMs + PUSH_LIMITS.clockSkewToleranceMs + 1
    expect(await store.pruneExpired()).toBe(1)
  })
})
