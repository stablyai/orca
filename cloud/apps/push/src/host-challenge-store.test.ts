import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'
import { PushHostChallengeStore } from './host-challenge-store.js'

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

  it('rejects an unknown challenge id and a malformed public key', async () => {
    await expect(store.verify('missing', Buffer.alloc(32, 9).toString('base64'))).resolves.toEqual({
      ok: false,
      reason: 'unknown_challenge'
    })
    await expect(store.issue('not-base64!!')).resolves.toBeNull()
    await expect(store.issue(Buffer.alloc(31, 1).toString('base64'))).resolves.toBeNull()
  })


})
