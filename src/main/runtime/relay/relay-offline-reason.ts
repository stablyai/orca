import {
  RELAY_HOST_CLOSE_REASON,
  type RelayHostCloseReason
} from '../../../shared/relay-host-close-reason'

// Why failures before a broker exists use their own words rather than the wire
// vocabulary: RelayHostCloseReason is what the phone is told, not why the
// desktop-side control has no broker to use. Three words because the fix
// differs: auth_unavailable never reached the relay (the cloud session could
// not be read or refreshed) and is being retried; broker_unavailable reached
// the relay, was refused transiently and is being retried; broker_rejected
// was refused for cause (4xx), arms no retry and wants a human.
export type RelayOfflineReason =
  | RelayHostCloseReason
  | 'not_entitled'
  | 'auth_unavailable'
  | 'broker_unavailable'
  | 'broker_rejected'

const RELAY_OFFLINE_REASON_CODES: Record<RelayOfflineReason, string> = {
  [RELAY_HOST_CLOSE_REASON.SIGNED_OUT]: 'relay_signed_out',
  not_entitled: 'relay_not_entitled',
  auth_unavailable: 'relay_auth_unavailable',
  broker_unavailable: 'relay_broker_unavailable',
  broker_rejected: 'relay_broker_rejected'
}

// reachedRelay is the identity key the open was attempted for; it is set only
// once the context read succeeded, so its absence means the failure never
// reached the relay.
export function relayOfflineReasonForOpenFailure(
  retryable: boolean,
  reachedRelay: string | undefined
): RelayOfflineReason {
  if (reachedRelay === undefined) {
    return 'auth_unavailable'
  }
  return retryable ? 'broker_unavailable' : 'broker_rejected'
}

// Why a lookup table instead of a switch: exhaustive over RelayOfflineReason,
// so a new reason fails typecheck here instead of silently falling back.
export function relayOfflineReasonMintFailureCode(reason: RelayOfflineReason | null): string {
  return reason ? RELAY_OFFLINE_REASON_CODES[reason] : 'relay_control_not_active'
}
