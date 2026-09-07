// Mirror of src/shared/relay-host-close-reason.ts in the Orca app repo half.
// A host control socket may close with one of these as its WebSocket close
// reason; the cell records it so a later phone rejection can name the cause.
// Anything else (including the empty reason of an abrupt 1006) means "unknown",
// which is what every peer that predates this file sends.
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
