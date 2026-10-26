import { describe, expect, it } from 'vitest'
import vector from '../../../cloud/packages/connector-contract/src/connector-host-proof-vector.json'
import { answerHostChallenge } from '../runtime/host-challenge-proof'
import { answerPushHostChallenge } from '../runtime/push/push-host-proof'
import { CONNECTOR_HOST_PROOF_DOMAINS } from './connector-host-session'

const context = {
  gatewayOrigin: vector.gatewayOrigin,
  hostFingerprint: vector.hostFingerprint,
  hostPublicKey: Buffer.from(vector.hostPublicKeyB64, 'base64'),
  hostSecretKey: Buffer.from(vector.hostSecretKeyB64, 'base64'),
  now: () => vector.issuedAt + 1_000
}

// Replay the cloud's checked-in vector so the two workspaces cannot drift apart on the domains.
describe('connector host proof vector', () => {
  it('answers the checked-in challenge with the expected proof', () => {
    const reasons: string[] = []
    expect(
      answerHostChallenge(
        vector.challenge,
        { ...context, onInvalid: (reason) => reasons.push(reason) },
        CONNECTOR_HOST_PROOF_DOMAINS
      )
    ).toBe(vector.proofB64)
    expect(reasons).toEqual([])
  })

  it('never answers as a push challenge', () => {
    expect(answerPushHostChallenge(vector.challenge, context)).toBeNull()
  })
})
