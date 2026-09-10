// Why: the push gateway authenticates this host the same way the relay does —
// a sealed box the host can only open with its X25519 E2EE secret key — but with
// its own domain strings and a transcript that names the host by fingerprint
// instead of by account. See docs/reference/mobile-push-contract.md.
import {
  encodeText,
  equalBytes,
  hostChallengeAckProof,
  openHostChallengeEnvelope,
  parseHostChallengeTranscript,
  readTranscriptUint64
} from '../host-challenge-envelope'

const PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-push-host-proof/v1'
const PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-push-host-challenge/v1'
const PUSH_HOST_PROOF_CLOCK_SKEW_MS = 30_000
const MAX_PUSH_HOST_PROOF_CHALLENGE_WINDOW_MS = 10_000
const PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT = 10

export type PushHostChallenge = {
  challengeId: string
  gatewayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
}

export type PushHostProofContext = {
  gatewayOrigin: string
  hostFingerprint: string
  hostPublicKey: Uint8Array
  hostSecretKey: Uint8Array
  now?: () => number
  /** Reports the failing check by name only; never receives field values. */
  onInvalid?: (reason: string) => void
}

function validateTranscript(
  transcript: Uint8Array,
  challenge: PushHostChallenge,
  context: PushHostProofContext,
  gatewayKey: Uint8Array,
  nonce: Uint8Array
): boolean {
  const fields = parseHostChallengeTranscript(transcript)
  if (!fields || fields.size !== PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT) {
    context.onInvalid?.('transcript-structure')
    return false
  }
  const now = (context.now ?? Date.now)()
  const issuedAt = readTranscriptUint64(fields.get('issuedAt'))
  const expiresAt = readTranscriptUint64(fields.get('expiresAt'))
  const checks: [string, boolean][] = [
    ['issuedAt-readable', issuedAt !== null],
    ['issuedAt-not-future', issuedAt === null || issuedAt - PUSH_HOST_PROOF_CLOCK_SKEW_MS <= now],
    ['not-expired', now - PUSH_HOST_PROOF_CLOCK_SKEW_MS <= challenge.expiresAt],
    ['issuedAt-before-expiry', issuedAt === null || issuedAt <= challenge.expiresAt],
    [
      'window',
      issuedAt === null || challenge.expiresAt - issuedAt <= MAX_PUSH_HOST_PROOF_CHALLENGE_WINDOW_MS
    ],
    ['expiry-consistent', expiresAt === challenge.expiresAt],
    ['protocol', equalBytes(fields.get('protocol'), encodeText(PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN))],
    ['version', equalBytes(fields.get('version'), new Uint8Array([1]))],
    ['gatewayOrigin', equalBytes(fields.get('gatewayOrigin'), encodeText(context.gatewayOrigin))],
    ['gatewayEphemeralPublicKey', equalBytes(fields.get('gatewayEphemeralPublicKey'), gatewayKey)],
    ['challengeNonce', equalBytes(fields.get('challengeNonce'), nonce)],
    ['challengeId', equalBytes(fields.get('challengeId'), encodeText(challenge.challengeId))],
    [
      'hostFingerprint',
      equalBytes(fields.get('hostFingerprint'), encodeText(context.hostFingerprint))
    ],
    ['hostPublicKey', equalBytes(fields.get('hostPublicKey'), context.hostPublicKey)]
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length > 0) {
    context.onInvalid?.(`transcript:${failed.join('+')}`)
    return false
  }
  return true
}

/** Returns the base64 HMAC proof for a valid challenge, or null for anything else. */
export function answerPushHostChallenge(
  challenge: PushHostChallenge,
  context: PushHostProofContext
): string | null {
  const envelope = openHostChallengeEnvelope({
    peerEphemeralPublicKeyB64: challenge.gatewayEphemeralPublicKeyB64,
    nonceB64: challenge.nonceB64,
    ciphertextB64: challenge.ciphertextB64,
    hostSecretKey: context.hostSecretKey,
    plaintextDomain: PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
    onInvalid: context.onInvalid
  })
  if (
    !envelope ||
    !validateTranscript(
      envelope.transcript,
      challenge,
      context,
      envelope.peerEphemeralPublicKey,
      envelope.nonce
    )
  ) {
    return null
  }
  return hostChallengeAckProof({
    secret: envelope.secret,
    transcript: envelope.transcript,
    proofDomain: PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN
  })
}
