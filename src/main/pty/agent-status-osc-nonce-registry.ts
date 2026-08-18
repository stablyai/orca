import {
  isWellFormedAgentStatusOscNonce,
  resolveAgentStatusOscNonceEnforcement,
  type AgentStatusOscNonceEnforcement
} from '../../shared/agent-status-osc-nonce'

/**
 * Per-PTY record of the agent-status nonce Orca stamped into that pane's env,
 * so main's OSC 9999 gate can verify what a payload presents.
 *
 * Recorded from the spawn env rather than minted here: the pane identity env
 * (ORCA_PANE_KEY and friends) is assembled by the caller that owns the pane, and
 * the nonce must match the value that pane's descendants actually inherited.
 * Lives in its own module so both the spawn path and the runtime can read it
 * without importing each other.
 */
const nonceByPtyId = new Map<string, string>()

/** Returns the recorded nonce, or null when the pane was spawned without one. */
export function recordAgentStatusOscNonceForPty(ptyId: string, nonce: unknown): string | null {
  if (!isWellFormedAgentStatusOscNonce(nonce)) {
    // Why: a reattach whose env we cannot see must keep the nonce the original
    // spawn recorded — dropping it would silently downgrade the pane.
    return nonceByPtyId.get(ptyId) ?? null
  }
  nonceByPtyId.set(ptyId, nonce)
  return nonce
}

export function getAgentStatusOscNonceForPty(ptyId: string): string | null {
  return nonceByPtyId.get(ptyId) ?? null
}

export function forgetAgentStatusOscNonceForPty(ptyId: string): void {
  nonceByPtyId.delete(ptyId)
}

/** Test-only reset; production teardown goes through forgetAgentStatusOscNonceForPty. */
export function clearAgentStatusOscNonceRegistry(): void {
  nonceByPtyId.clear()
}

/**
 * Undocumented opt-in for users who want the gate to bite before the default
 * flips: `ORCA_AGENT_STATUS_OSC_NONCE=enforce`.
 */
export function getAgentStatusOscNonceEnforcement(): AgentStatusOscNonceEnforcement {
  return resolveAgentStatusOscNonceEnforcement(process.env.ORCA_AGENT_STATUS_OSC_NONCE)
}
