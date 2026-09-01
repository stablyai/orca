// Availability mutations for the agent catalog: enable/disable an agent and set
// the default. Both keep the default launchable — never left pointing at a
// disabled agent or one derived from a disabled base.

import type { CustomTuiAgentId, GlobalSettings, TuiAgent } from '../../shared/types'
import { isCustomTuiAgentId, type AgentCatalog } from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import type { AgentCatalogMutationApplication } from './agent-catalog-draft-validation'
import type { ApplyAgentCatalogMutationArgs } from './agent-catalog-mutations'

export function applySetEnabled(
  agent: TuiAgent,
  enabled: boolean,
  context: { args: ApplyAgentCatalogMutationArgs; catalog: AgentCatalog; newRevision: number }
): AgentCatalogMutationApplication {
  const { catalog, args } = context
  const known =
    isBuiltInTuiAgent(agent) ||
    (isCustomTuiAgentId(agent) &&
      (catalog.liveById.has(agent) || catalog.repairRequiredById.has(agent)))
  if (!known) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  const current = args.settings.disabledTuiAgents ?? []
  const without = current.filter((entry) => entry !== agent)
  const nextDisabled = enabled ? without : [...without, agent]
  const patch: Partial<GlobalSettings> = {
    disabledTuiAgents: nextDisabled,
    agentCatalogRevision: context.newRevision
  }
  if (!enabled && isBuiltInTuiAgent(agent)) {
    // Disabling a base repairs a base/derivative default to null in the same
    // write: no fallback is launchable under a disabled base. Auto stays Auto.
    const currentDefault = args.settings.defaultTuiAgent
    if (currentDefault === agent) {
      patch.defaultTuiAgent = null
    } else if (isCustomTuiAgentId(currentDefault ?? undefined)) {
      const identity =
        catalog.liveById.get(currentDefault as CustomTuiAgentId) ??
        catalog.tombstonesById.get(currentDefault as CustomTuiAgentId) ??
        catalog.repairRequiredById.get(currentDefault as CustomTuiAgentId)
      if (identity && 'baseAgent' in identity && identity.baseAgent === agent) {
        patch.defaultTuiAgent = null
      }
    }
  }
  return { ok: true, patch, newRevision: context.newRevision, prunedTombstoneIds: [] }
}

export function applySetDefault(
  target: TuiAgent | 'auto' | 'blank',
  catalog: AgentCatalog,
  newRevision: number
): AgentCatalogMutationApplication {
  if (target !== 'auto' && target !== 'blank') {
    const identity = isBuiltInTuiAgent(target)
      ? target
      : catalog.liveById.get(target)
        ? target
        : null
    if (!identity) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
    const base = isBuiltInTuiAgent(target)
      ? target
      : catalog.liveById.get(target as CustomTuiAgentId)?.baseAgent
    if (
      catalog.disabledAgents.has(target) ||
      (base !== undefined && catalog.disabledAgents.has(base))
    ) {
      return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
    }
  }
  return {
    ok: true,
    patch: { defaultTuiAgent: target, agentCatalogRevision: newRevision },
    newRevision,
    prunedTombstoneIds: []
  }
}
