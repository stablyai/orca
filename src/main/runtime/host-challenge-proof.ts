// Authenticate host E2EE keys via a sealed challenge; each cloud service names its own domains (push, connector).
import {
  encodeText,
  equalBytes,
  hostChallengeAckProof,
  openHostChallengeEnvelope,
  parseHostChallengeTranscript,
  readTranscriptUint64
} from './host-challenge-envelope'

const HOST_PROOF_CLOCK_SKEW_MS = 30_000
const MAX_HOST_PROOF_CHALLENGE_WINDOW_MS = 10_000
const HOST_PROOF_TRANSCRIPT_FIELD_COUNT = 10

export type HostProofDomains = { transcript: string; challengePlaintext: string }

export type HostChallenge = {
  challengeId: string
  gatewayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
}

export type HostProofContext = {
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
  challenge: HostChallenge,
  context: HostProofContext,
  domains: HostProofDomains,
  gatewayKey: Uint8Array,
  nonce: Uint8Array
): boolean {
  const fields = parseHostChallengeTranscript(transcript)
  if (!fields || fields.size !== HOST_PROOF_TRANSCRIPT_FIELD_COUNT) {
    context.onInvalid?.('transcript-structure')
    return false
  }
  const now = (context.now ?? Date.now)()
  const issuedAt = readTranscriptUint64(fields.get('issuedAt'))
  const expiresAt = readTranscriptUint64(fields.get('expiresAt'))
  const checks: [string, boolean][] = [
    ['issuedAt-readable', issuedAt !== null],
    ['issuedAt-not-future', issuedAt === null || issuedAt - HOST_PROOF_CLOCK_SKEW_MS <= now],
    ['not-expired', now - HOST_PROOF_CLOCK_SKEW_MS <= challenge.expiresAt],
    ['issuedAt-before-expiry', issuedAt === null || issuedAt <= challenge.expiresAt],
    [
      'window',
      issuedAt === null || challenge.expiresAt - issuedAt <= MAX_HOST_PROOF_CHALLENGE_WINDOW_MS
    ],
    ['expiry-consistent', expiresAt === challenge.expiresAt],
    ['protocol', equalBytes(fields.get('protocol'), encodeText(domains.transcript))],
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
export function answerHostChallenge(
  challenge: HostChallenge,
  context: HostProofContext,
  domains: HostProofDomains
): string | null {
  const envelope = openHostChallengeEnvelope({
    peerEphemeralPublicKeyB64: challenge.gatewayEphemeralPublicKeyB64,
    nonceB64: challenge.nonceB64,
    ciphertextB64: challenge.ciphertextB64,
    hostSecretKey: context.hostSecretKey,
    plaintextDomain: domains.challengePlaintext,
    onInvalid: context.onInvalid
  })
  if (
    !envelope ||
    !validateTranscript(
      envelope.transcript,
      challenge,
      context,
      domains,
      envelope.peerEphemeralPublicKey,
      envelope.nonce
    )
  ) {
    return null
  }
  return hostChallengeAckProof({
    secret: envelope.secret,
    transcript: envelope.transcript,
    proofDomain: domains.transcript
  })
}
