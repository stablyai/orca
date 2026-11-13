// Why auth ended a profile's sign-in, when it said so in a way worth telling the person apart from
// "your session expired". Today that is one case: their team turned on single sign-on, and the
// sign-in they had predates it (refresh refused with `reason: "sso_required"`).
//
// Kept in memory only: after a restart the generic sign-in-again copy shows, which is still true,
// and the sign-in page offers SSO either way.
import type { OrcaProfileReconnectReason } from '../../../shared/orca-profile-reconnect-reason'

const reasons = new Map<string, OrcaProfileReconnectReason>()

/** Auth's `reason` on a refused refresh, mapped to what the app explains; undefined for the rest. */
export function reconnectReasonFromRefusal(
  reason: string | undefined
): OrcaProfileReconnectReason | undefined {
  return reason === 'sso_required' ? 'sso-required' : undefined
}

export function rememberReconnectReason(
  profileId: string,
  reason: OrcaProfileReconnectReason | undefined
): void {
  if (reason) {
    reasons.set(profileId, reason)
  } else {
    reasons.delete(profileId)
  }
}

export function getReconnectReason(profileId: string): OrcaProfileReconnectReason | undefined {
  return reasons.get(profileId)
}
