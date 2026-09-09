import {
  RELAY_HOST_CLOSE_REASON,
  type RelayHostCloseReason
} from '../../../shared/relay-host-close-reason'

// Why a broker-open failure earns 'broker_unavailable' rather than the wire
// vocabulary: RelayHostCloseReason is what the phone is told, not why the
// desktop-side control has no broker to use.
export type RelayOfflineReason = RelayHostCloseReason | 'not_entitled' | 'broker_unavailable'

const RELAY_OFFLINE_REASON_CODES: Record<RelayOfflineReason, string> = {
  [RELAY_HOST_CLOSE_REASON.SIGNED_OUT]: 'relay_signed_out',
  not_entitled: 'relay_not_entitled',
  broker_unavailable: 'relay_broker_unavailable'
}

// Why a lookup table instead of a switch: exhaustive over RelayOfflineReason,
// so a new reason fails typecheck here instead of silently falling back.
export function relayOfflineReasonMintFailureCode(reason: RelayOfflineReason | null): string {
  return reason ? RELAY_OFFLINE_REASON_CODES[reason] : 'relay_control_not_active'
}
