import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import vector from '../../../../cloud/packages/push-contract/src/push-host-proof-vector.json'
import { answerPushHostChallenge } from './push-host-proof'

// Why: the gateway builds the challenge and this file answers it, in two
// workspaces that cannot import each other in CI. Both replay one checked-in
// vector; a transcript field drift on either side fails here and in the
// gateway's copy of this test.
describe('push host proof vector', () => {
  it('answers the checked-in gateway challenge with the expected proof', () => {
    const secret = Buffer.from(vector.challengeSecretB64, 'base64')
    const transcript = Buffer.from(vector.transcriptB64, 'base64')
    const expected = createHmac('sha256', secret)
      .update(Buffer.from('orca-push-host-proof/v1\0ack\0'))
      .update(transcript)
      .digest('base64')
    const reasons: string[] = []
    const proof = answerPushHostChallenge(vector.challenge, {
      gatewayOrigin: vector.gatewayOrigin,
      hostFingerprint: vector.hostFingerprint,
      hostPublicKey: Buffer.from(vector.hostPublicKeyB64, 'base64'),
      hostSecretKey: Buffer.from(vector.hostSecretKeyB64, 'base64'),
      now: () => vector.issuedAt + 1_000,
      onInvalid: (reason) => reasons.push(reason)
    })
    expect(reasons).toEqual([])
    expect(proof).toBe(expected)
  })
})
