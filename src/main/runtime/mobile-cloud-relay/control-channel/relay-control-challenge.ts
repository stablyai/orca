import type { RelayControlClientOptions } from './relay-control-client-options'
import { answerRelayHostChallenge, type RelayHostChallenge } from './relay-host-proof'

// The proof answering this control's host-challenge, or why the challenge is not one this control
// can answer. A failure names the failing check, never challenge field values.
export function proveRelayHostChallenge(
  challenge: RelayHostChallenge,
  options: RelayControlClientOptions,
  relayOrigin: string
): { proofB64: string } | { failure: string | Error } {
  const invalid: { reason: string | Error } = { reason: 'unknown' }
  const proofB64 = answerRelayHostChallenge(challenge, {
    relayOrigin,
    ...options.identity,
    relayHostId: options.relayHostId,
    hostPublicKey: options.keypair.publicKey,
    hostSecretKey: options.keypair.secretKey,
    assignmentEpoch: options.assignmentEpoch,
    previousGeneration: options.previousGeneration,
    resumeRequested: Boolean(options.controlResumeSecret),
    onInvalid: (reason, error) => {
      invalid.reason = error ?? reason
    }
  })
  if (proofB64) {
    return { proofB64 }
  }
  return {
    failure:
      invalid.reason instanceof Error
        ? invalid.reason
        : `invalid host challenge: ${invalid.reason} origin=${relayOrigin}`
  }
}
