// Keep retired-key state transitions here and transaction ownership in the store.

import type { AgentSessionStoreState } from '../../agent-session-store-state'

/** Retired claim keys stay verifiable this long so a rotation cannot strand a running agent. */
export const AGENT_SESSION_CLAIM_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function isAgentSessionClaimKeyVerifiable(
  state: AgentSessionStoreState,
  keyId: string,
  now: number
): boolean {
  const retired = state.retiredClaimKeys.find((entry) => entry.keyId === keyId)
  return !retired || now - retired.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS
}

export function retireAgentSessionClaimKey(
  state: AgentSessionStoreState,
  keyId: string,
  now: number
): void {
  if (!state.retiredClaimKeys.some((entry) => entry.keyId === keyId)) {
    state.retiredClaimKeys.push({ keyId, retiredAt: now })
  }
  state.retiredClaimKeys = state.retiredClaimKeys.filter(
    (entry) => now - entry.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS
  )
}
