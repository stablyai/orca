// Draft validation and definition building for agent-catalog mutations: field
// checks, label-collision rules, tombstone pruning, and per-agent cache cleanup.
// Pure helpers shared by the mutation engine and repair mutations.

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings,
  TuiAgent
} from '../../shared/types'
import type { CustomAgentDraft } from '../../shared/agent-catalog-snapshot'
import {
  canonicalizeCommandOverride,
  isBuiltInAgentLabelKey,
  normalizeAgentLabelKey,
  normalizeAgentLabelText,
  validateAgentArgs,
  validateAgentLabel,
  validateCommandOverride,
  validateCustomAgentEnv,
  type AgentCatalog,
  type AgentFieldIssue
} from '../../shared/custom-tui-agents'
import { canonicalizeAgentArgsLineEndings } from '../../shared/agent-args-tokenizer'

export type AgentCatalogMutationError = {
  ok: false
  code:
    | 'catalog_revision_conflict'
    | 'duplicate_agent_label'
    | 'invalid_agent_field'
    | 'stale_agent_repair_token'
    | 'agent_catalog_local_payload_too_large'
    | 'agent_catalog_payload_too_large'
  field?: 'label' | 'commandOverride' | 'args' | 'env'
  reason?:
    | 'empty'
    | 'bounds'
    | 'reserved_name'
    | 'prototype_key'
    | 'case_collision'
    | 'control_char'
    | 'unterminated_quote'
    | 'quoted_line_break'
    | 'shell_operator'
    | 'platform_ambiguous'
    | 'duplicate_id'
    | 'identity_mismatch'
    | 'env_total_bounds'
  envEntryIndex?: number
}

export type AgentCatalogMutationApplication =
  | {
      ok: true
      /** Applied in one store write; includes the bumped catalog revision. */
      patch: Partial<GlobalSettings>
      newRevision: number
      mintedId?: CustomTuiAgentId
      prunedTombstoneIds: CustomTuiAgentId[]
    }
  | AgentCatalogMutationError

export type TombstoneReferenceCount = number | 'unknown'

export function fieldError(issue: AgentFieldIssue): AgentCatalogMutationError {
  return {
    ok: false,
    code: 'invalid_agent_field',
    field: issue.field === 'identity' || issue.field === 'baseAgent' ? undefined : issue.field,
    reason: issue.reason,
    ...(issue.envEntryIndex !== undefined ? { envEntryIndex: issue.envEntryIndex } : {})
  }
}

export function validateDraft(draft: CustomAgentDraft): AgentCatalogMutationError | null {
  const labelIssue = validateAgentLabel(draft.label)
  if (labelIssue) {
    return fieldError(labelIssue)
  }
  if (draft.commandOverride !== null && draft.commandOverride !== undefined) {
    const commandIssue = validateCommandOverride(draft.commandOverride)
    if (commandIssue) {
      return fieldError(commandIssue)
    }
  }
  // IPC validates only the mutation envelope, so a draft missing args/env must
  // fail typed here instead of throwing inside draftToDefinition.
  if (typeof draft.args !== 'string') {
    return { ok: false, code: 'invalid_agent_field', field: 'args', reason: 'bounds' }
  }
  const argsIssue = validateAgentArgs(draft.args)
  if (argsIssue) {
    return fieldError(argsIssue)
  }
  if (draft.env === null || draft.env === undefined) {
    return { ok: false, code: 'invalid_agent_field', field: 'env', reason: 'bounds' }
  }
  const envIssues = validateCustomAgentEnv(draft.env)
  if (envIssues.length > 0) {
    return fieldError(envIssues[0])
  }
  return null
}

export function draftToDefinition(
  id: CustomTuiAgentId,
  baseAgent: BuiltInTuiAgent,
  draft: CustomAgentDraft
): CustomTuiAgent {
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(draft.env)) {
    env[key] = value
  }
  const commandOverride =
    draft.commandOverride === null || draft.commandOverride === undefined
      ? undefined
      : canonicalizeCommandOverride(draft.commandOverride)
  return {
    id,
    baseAgent,
    label: normalizeAgentLabelText(draft.label),
    ...(commandOverride ? { commandOverride } : {}),
    args: canonicalizeAgentArgsLineEndings(draft.args),
    env,
    syncEnv: draft.syncEnv === true
  }
}

/** Labels reserved against the new/edited label: built-in canonical names, live
 *  custom labels (excluding the row being edited), and referenced tombstones. */
export function labelCollides(
  candidateKey: string,
  catalog: AgentCatalog,
  retainedTombstones: readonly DeletedCustomTuiAgent[],
  excludeId?: CustomTuiAgentId
): boolean {
  if (isBuiltInAgentLabelKey(candidateKey)) {
    return true
  }
  for (const agent of catalog.liveCustomAgents) {
    if (agent.id !== excludeId && normalizeAgentLabelKey(agent.label) === candidateKey) {
      return true
    }
  }
  for (const tombstone of retainedTombstones) {
    if (normalizeAgentLabelKey(tombstone.label) === candidateKey) {
      return true
    }
  }
  return false
}

type AgentKeyedCacheHolder = {
  selectedModelByAgent?: Partial<Record<TuiAgent, string>>
  selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<TuiAgent, string>>>>
  discoveredModelsByAgent?: Partial<Record<TuiAgent, unknown>>
  discoveredModelsByAgentByHost?: Partial<Record<string, Partial<Record<TuiAgent, unknown>>>>
}

function stripAgentKeysFromHolder(holder: AgentKeyedCacheHolder, id: CustomTuiAgentId): boolean {
  let changed = false
  for (const flat of [holder.selectedModelByAgent, holder.discoveredModelsByAgent]) {
    if (flat && id in flat) {
      delete flat[id]
      changed = true
    }
  }
  for (const byHost of [holder.selectedModelByAgentByHost, holder.discoveredModelsByAgentByHost]) {
    if (!byHost) {
      continue
    }
    for (const host of Object.keys(byHost)) {
      const byAgent = byHost[host]
      if (byAgent && id in byAgent) {
        delete byAgent[id]
        changed = true
      }
    }
  }
  return changed
}

// Ids are never reused, so per-agent model/discovery caches keyed by the deleted
// id are removed in the same settings write instead of lingering forever.
export function stripAgentKeyedModelCaches(
  settings: GlobalSettings,
  id: CustomTuiAgentId
): Partial<GlobalSettings> {
  const patch: Partial<GlobalSettings> = {}
  if (settings.sourceControlAi) {
    const next = structuredClone(settings.sourceControlAi)
    let changed = stripAgentKeysFromHolder(next, id)
    for (const choice of Object.values(next.modelOverridesByOperation ?? {})) {
      if (choice && stripAgentKeysFromHolder(choice, id)) {
        changed = true
      }
    }
    if (changed) {
      patch.sourceControlAi = next
    }
  }
  if (settings.commitMessageAi) {
    const next = structuredClone(settings.commitMessageAi)
    if (stripAgentKeysFromHolder(next, id)) {
      patch.commitMessageAi = next
    }
  }
  return patch
}
