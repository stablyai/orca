import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { deriveHostFingerprint } from './host-fingerprint.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import { openInMemoryPushDatabase } from './push-database.js'
// Why: the gateway's challenge builder and the desktop's answerer were written
// separately. This is the only test that runs the real desktop code against a
// real gateway-issued challenge, so a transcript field drift fails here first.
import { answerPushHostChallenge } from '../../../../src/main/runtime/push/push-host-proof.js'

const GATEWAY_ORIGIN = 'https://push.onorca.dev'

describe('desktop host proof interop', () => {
  it('desktop answers a gateway-issued challenge and the gateway accepts it once', async () => {
    const database = await openInMemoryPushDatabase()
    const store = new PushHostChallengeStore(database, GATEWAY_ORIGIN)
    const host = nacl.box.keyPair()
    const hostPublicKeyB64 = Buffer.from(host.publicKey).toString('base64')

    const challenge = await store.issue(hostPublicKeyB64)
    expect(challenge).not.toBeNull()

    const proof = answerPushHostChallenge(
      {
        challengeId: challenge!.challengeId,
        gatewayEphemeralPublicKeyB64: challenge!.gatewayEphemeralPublicKeyB64,
        nonceB64: challenge!.nonceB64,
        ciphertextB64: challenge!.ciphertextB64,
        expiresAt: challenge!.expiresAt
      },
      {
        gatewayOrigin: GATEWAY_ORIGIN,
        hostFingerprint: deriveHostFingerprint(host.publicKey),
        hostPublicKey: host.publicKey,
        hostSecretKey: host.secretKey,
        onInvalid: (reason: string) => {
          throw new Error(`desktop rejected gateway challenge: ${reason}`)
        }
      }
    )
    expect(proof).not.toBeNull()

    expect(await store.verify(challenge!.challengeId, proof!)).toEqual({
      ok: true,
      hostFingerprint: deriveHostFingerprint(host.publicKey)
    })
    expect(await store.verify(challenge!.challengeId, proof!)).toEqual({
      ok: false,
      reason: 'already_consumed'
    })
    await database.close()
  })

  it('desktop refuses a challenge issued for a different gateway origin', async () => {
    const database = await openInMemoryPushDatabase()
    const store = new PushHostChallengeStore(database, 'https://push.example.invalid')
    const host = nacl.box.keyPair()
    const challenge = await store.issue(Buffer.from(host.publicKey).toString('base64'))
    const reasons: string[] = []
    const proof = answerPushHostChallenge(
      {
        challengeId: challenge!.challengeId,
        gatewayEphemeralPublicKeyB64: challenge!.gatewayEphemeralPublicKeyB64,
        nonceB64: challenge!.nonceB64,
        ciphertextB64: challenge!.ciphertextB64,
        expiresAt: challenge!.expiresAt
      },
      {
        gatewayOrigin: GATEWAY_ORIGIN,
        hostFingerprint: deriveHostFingerprint(host.publicKey),
        hostPublicKey: host.publicKey,
        hostSecretKey: host.secretKey,
        onInvalid: (reason: string) => reasons.push(reason)
      }
    )
    expect(proof).toBeNull()
    expect(reasons.join(' ')).toContain('gatewayOrigin')
    await database.close()
  })
})
