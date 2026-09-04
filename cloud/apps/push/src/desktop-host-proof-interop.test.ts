import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import vector from '../../../packages/push-contract/src/push-host-proof-vector.json' with { type: 'json' }
import { answerPushHostChallenge, createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import { deriveHostFingerprint } from './host-fingerprint.js'
import { openInMemoryPushDatabase } from './push-database.js'

// Why: the desktop answers challenges in a workspace this one cannot import.
// Both sides replay the same checked-in vector, so a transcript drift on
// either side fails in that side's own suite.
describe('desktop host proof interop', () => {
  it('the checked-in vector answers to the same proof the fixture host computes', () => {
    const secretKey = new Uint8Array(Buffer.from(vector.hostSecretKeyB64, 'base64'))
    const keypair = { publicKey: new Uint8Array(Buffer.from(vector.hostPublicKeyB64, 'base64')), secretKey }
    expect(deriveHostFingerprint(keypair.publicKey)).toBe(vector.hostFingerprint)
    const proof = answerPushHostChallenge(vector.challenge, {
      gatewayOrigin: vector.gatewayOrigin,
      keypair,
      now: () => vector.issuedAt + 1_000
    })
    const expected = createHmac('sha256', Buffer.from(vector.challengeSecretB64, 'base64'))
      .update(Buffer.from('orca-push-host-proof/v1\0ack\0'))
      .update(Buffer.from(vector.transcriptB64, 'base64'))
      .digest('base64')
    expect(proof).toBe(expected)
  })

  it('a live challenge from the store round-trips through the fixture host once', async () => {
    const database = await openInMemoryPushDatabase()
    const store = new PushHostChallengeStore(database, vector.gatewayOrigin)
    const keypair = createPushHostKeypair(11)
    const challenge = await store.issue(Buffer.from(keypair.publicKey).toString('base64'))
    expect(challenge).not.toBeNull()
    const proof = answerPushHostChallenge(challenge!, { gatewayOrigin: vector.gatewayOrigin, keypair })
    expect(proof).not.toBeNull()
    expect(await store.verify(challenge!.challengeId, proof!)).toEqual({
      ok: true,
      hostFingerprint: deriveHostFingerprint(keypair.publicKey)
    })
    expect(await store.verify(challenge!.challengeId, proof!)).toEqual({
      ok: false,
      reason: 'already_consumed'
    })
    await database.close()
  })
})
