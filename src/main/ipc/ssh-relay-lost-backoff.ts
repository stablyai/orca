import type { SshConnectionStatus } from '../../shared/ssh-types'

// Why: without backoff, a relay channel that keeps dying reconnects as fast as the network allows, hammering local + remote sshd; track attempts and back off to end the loop recoverably.
export type RelayLostBackoffState = {
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  stabilizedTimer: ReturnType<typeof setTimeout> | null
}
export const relayLostBackoff = new Map<string, RelayLostBackoffState>()
export const RELAY_LOST_MAX_ATTEMPTS = 6
export const RELAY_LOST_BASE_DELAY_MS = 500
export const RELAY_LOST_MAX_DELAY_MS = 15_000
// Why: a reconnect whose mux dies within this window was a flap, not a recovery — don't reset the attempt counter. 5s covers provider re-registration + PTY reattach.
export const RELAY_LOST_STABILIZED_MS = 5_000
// Why: transport states the SSH ladder never leaves on its own — waiting for a relay redeploy past one of these is an unbounded loop.
export const TRANSPORT_TERMINAL_STATUSES = new Set<SshConnectionStatus>([
  'disconnected',
  'auth-failed',
  'reconnection-failed',
  'error'
])

export function clearRelayLostBackoff(targetId: string): void {
  const state = relayLostBackoff.get(targetId)
  if (state?.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }
  if (state?.stabilizedTimer) {
    clearTimeout(state.stabilizedTimer)
  }
  relayLostBackoff.delete(targetId)
}
