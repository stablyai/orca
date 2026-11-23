import type { ConnectionState } from '../connection/connection-state'

// Replace dials predating revival, but coalesce back-to-back foreground and network-change nudges.
const STALE_DIAL_AGE_MS = 2_000
export const NETWORK_FOLLOW_UP_STALE_DIAL_AGE_MS = 2 * STALE_DIAL_AGE_MS

// RN may retain CONNECTING across suspension without a close event; waiting out that dial delays recovery on a dead path.
export function isStaleForegroundDial(
  state: ConnectionState,
  dialAgeMs: number,
  followUp = false
): boolean {
  if (followUp) {
    // An open WebSocket already proved the path works. Let its handshake deadline own recovery.
    return state === 'connecting' && dialAgeMs >= NETWORK_FOLLOW_UP_STALE_DIAL_AGE_MS
  }
  return (state === 'connecting' || state === 'handshaking') && dialAgeMs >= STALE_DIAL_AGE_MS
}
