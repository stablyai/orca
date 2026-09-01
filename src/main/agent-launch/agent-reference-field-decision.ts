// Field-level agent-reference decision engine shared by every owner mutation
// (quick commands, commit-message, Source Control recipes). Enforces the
// stale-reference write rule so unrelated edits save while a proven stale
// reference is preserved, and a *changed* agent must be a currently effectively
// enabled live identity.

import type { TuiAgent } from '../../shared/types'
import { CUSTOM_AGENT_ID } from '../../shared/commit-message-agent-spec'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { isCustomTuiAgentId, type AgentCatalog } from '../../shared/custom-tui-agents'

/** A changed agent reference must resolve to a currently effectively enabled
 *  live identity: enabled built-in, or live custom whose own id and base are
 *  both enabled. Stale/tombstoned ids never enter through a *change*. */
export function isEffectivelyEnabledLiveIdentity(agent: TuiAgent, catalog: AgentCatalog): boolean {
  if (isBuiltInTuiAgent(agent)) {
    return !catalog.disabledAgents.has(agent)
  }
  if (!isCustomTuiAgentId(agent)) {
    return false
  }
  const definition = catalog.liveById.get(agent)
  if (!definition) {
    return false
  }
  return !catalog.disabledAgents.has(agent) && !catalog.disabledAgents.has(definition.baseAgent)
}

export type AgentFieldDecision =
  | { ok: true; value: TuiAgent | typeof CUSTOM_AGENT_ID | null | undefined }
  | { ok: false; reason: 'unknown_agent' | 'disabled_agent' }

/** Field-level rule: undefined preserves stored; the exact stored value (even a
 *  stale custom id) is a no-op; null clears; anything else must be enabled+live
 *  (or the commit-message 'custom' sentinel where allowed). */
export function decideAgentField(args: {
  incoming: unknown
  stored: unknown
  catalog: AgentCatalog
  allowCustomSentinel: boolean
}): AgentFieldDecision {
  const { incoming, stored, catalog, allowCustomSentinel } = args
  if (incoming === undefined) {
    return { ok: true, value: undefined }
  }
  if (incoming === null) {
    return { ok: true, value: null }
  }
  if (incoming === stored) {
    return { ok: true, value: stored as TuiAgent }
  }
  if (allowCustomSentinel && incoming === CUSTOM_AGENT_ID) {
    return { ok: true, value: CUSTOM_AGENT_ID }
  }
  if (typeof incoming !== 'string') {
    return { ok: false, reason: 'unknown_agent' }
  }
  if (isBuiltInTuiAgent(incoming)) {
    return catalog.disabledAgents.has(incoming)
      ? { ok: false, reason: 'disabled_agent' }
      : { ok: true, value: incoming }
  }
  if (isCustomTuiAgentId(incoming)) {
    if (!catalog.liveById.has(incoming)) {
      return { ok: false, reason: 'unknown_agent' }
    }
    return isEffectivelyEnabledLiveIdentity(incoming, catalog)
      ? { ok: true, value: incoming }
      : { ok: false, reason: 'disabled_agent' }
  }
  return { ok: false, reason: 'unknown_agent' }
}
