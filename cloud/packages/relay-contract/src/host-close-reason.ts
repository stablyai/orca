// Mirror src/shared/relay-host-close-reason.ts; record host socket reasons for later phone refusals.
// Unknown/empty reasons, including abrupt 1006 and older peers, mean unknown.
export const RELAY_HOST_CLOSE_REASON = {
  SIGNED_OUT: 'signed-out'
} as const

export type RelayHostCloseReason =
  (typeof RELAY_HOST_CLOSE_REASON)[keyof typeof RELAY_HOST_CLOSE_REASON]

const REASONS: readonly string[] = Object.values(RELAY_HOST_CLOSE_REASON)

export function relayHostCloseReasonFrom(value: unknown): RelayHostCloseReason | null {
  const text = typeof value === 'string' ? value : (value?.toString() ?? '')
  return REASONS.includes(text) ? (text as RelayHostCloseReason) : null
}
