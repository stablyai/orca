// Push's domains for the shared host challenge (cloud/packages/push-contract/src).
import {
  answerHostChallenge,
  type HostChallenge,
  type HostProofContext,
  type HostProofDomains
} from '../host-challenge-proof'

const PUSH_HOST_PROOF_DOMAINS: HostProofDomains = {
  transcript: 'orca-push-host-proof/v1',
  challengePlaintext: 'orca-push-host-challenge/v1'
}

export type PushHostChallenge = HostChallenge
export type PushHostProofContext = HostProofContext

/** Returns the base64 HMAC proof for a valid push challenge, or null for anything else. */
export function answerPushHostChallenge(
  challenge: PushHostChallenge,
  context: PushHostProofContext
): string | null {
  return answerHostChallenge(challenge, context, PUSH_HOST_PROOF_DOMAINS)
}
