import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  buildPushHostChallengePlaintext,
  buildPushHostProofMacInput,
  buildPushHostProofTranscript,
  PUSH_LIMITS
} from '@orca-cloud/push-contract'
import nacl from 'tweetnacl'
import { decodeCanonicalBase64 } from './canonical-base64.js'
import { deriveHostFingerprint } from './host-fingerprint.js'
import type { PushDatabase } from './push-database.js'

export type IssuedPushChallenge = {
  challengeId: string
  gatewayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
  hostFingerprint: string
}

export type PushProofVerification =
  | { ok: true; hostFingerprint: string }
  | { ok: false; reason: 'unknown_challenge' | 'already_consumed' | 'expired' | 'proof_mismatch' }

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url')
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export class PushHostChallengeStore {
  constructor(
    private readonly database: PushDatabase,
    private readonly gatewayOrigin: string,
    private readonly now: () => number = Date.now
  ) {}

  async issue(hostPublicKeyB64: string): Promise<IssuedPushChallenge | null> {
    const hostPublicKey = decodeCanonicalBase64(hostPublicKeyB64, 32)
    if (!hostPublicKey) return null
    const hostFingerprint = deriveHostFingerprint(hostPublicKey)
    const ephemeral = nacl.box.keyPair()
    const challengeNonce = randomBytes(nacl.box.nonceLength)
    const challengeSecret = randomBytes(32)
    const challengeId = randomUUID()
    const issuedAt = this.now()
    const expiresAt = issuedAt + PUSH_LIMITS.challengeTtlMs
    const transcript = buildPushHostProofTranscript({
      gatewayOrigin: this.gatewayOrigin,
      gatewayEphemeralPublicKey: ephemeral.publicKey,
      challengeNonce,
      challengeId,
      issuedAt,
      expiresAt,
      hostFingerprint,
      hostPublicKey
    })
    const ciphertext = nacl.box(
      buildPushHostChallengePlaintext(transcript, challengeSecret),
      challengeNonce,
      hostPublicKey,
      ephemeral.secretKey
    )
    const expectedProof = createHmac('sha256', challengeSecret)
      .update(buildPushHostProofMacInput(transcript))
      .digest()
    await this.database.query(
      `INSERT INTO push_challenges
       (challenge_id, host_fingerprint, secret_hash, expires_at,
        consumed_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [
        challengeId,
        hostFingerprint,
        // The stored digest is of the ack the secret produces, never of the
        // secret itself: a database reader must not be able to forge a proof.
        sha256(expectedProof),
        expiresAt
      ]
    )
    return {
      challengeId,
      gatewayEphemeralPublicKeyB64: Buffer.from(ephemeral.publicKey).toString('base64'),
      nonceB64: Buffer.from(challengeNonce).toString('base64'),
      ciphertextB64: Buffer.from(ciphertext).toString('base64'),
      expiresAt,
      hostFingerprint
    }
  }

  async verify(challengeId: string, proofB64: string): Promise<PushProofVerification> {
    const proof = decodeCanonicalBase64(proofB64, 32)
    return await this.database.transaction<PushProofVerification>(async (transaction) => {
      const [row] = await transaction.query(
        `SELECT host_fingerprint, secret_hash, expires_at, consumed_at
         FROM push_challenges WHERE challenge_id = ?`,
        [challengeId]
      )
      if (!row) return { ok: false, reason: 'unknown_challenge' }
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        return { ok: false, reason: 'already_consumed' }
      }
      const now = this.now()
      // No skew allowance here: the gateway set expires_at from this same clock.
      // The tolerance belongs to the host, which validates a foreign timestamp.
      if (now > Number(row.expires_at)) return { ok: false, reason: 'expired' }
      if (!proof || !equalDigest(sha256(proof), String(row.secret_hash))) {
        return { ok: false, reason: 'proof_mismatch' }
      }
      // Consume under the same predicate the read used, so two concurrent
      // proofs for one challenge cannot both mint a session.
      const [consumed] = await transaction.query(
        'UPDATE push_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL',
        [now, challengeId]
      )
      if (Number(consumed?.changes ?? 0) !== 1) return { ok: false, reason: 'already_consumed' }
      return { ok: true, hostFingerprint: String(row.host_fingerprint) }
    })
  }

  // Rows outlive the expiry check by the skew tolerance so a late proof reads
  // as 'expired' rather than as an unknown challenge.
  async pruneExpired(): Promise<number> {
    const cutoff = this.now() - PUSH_LIMITS.clockSkewToleranceMs
    const [result] = await this.database.query('DELETE FROM push_challenges WHERE expires_at < ?', [
      cutoff
    ])
    return Number(result?.changes ?? 0)
  }
}
