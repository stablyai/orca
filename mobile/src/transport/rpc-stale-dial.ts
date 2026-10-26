import type { ConnectionState } from './types'

// Replace dials predating revival, but coalesce back-to-back foreground and network-change nudges.
const STALE_DIAL_AGE_MS = 2_000

// RN may retain CONNECTING across suspension without a close event; waiting out that dial delays recovery on a dead path.
export function isStaleForegroundDial(state: ConnectionState, dialAgeMs: number): boolean {
  return (state === 'connecting' || state === 'handshaking') && dialAgeMs >= STALE_DIAL_AGE_MS
}
