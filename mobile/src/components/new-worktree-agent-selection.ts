import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import {
  buildMobileAgentPickerRows,
  type MobileAgentPickerOptions
} from '../tasks/mobile-agent-catalog-projection'
import {
  pickWorkspaceAgent,
  type WorkspaceCustomAgentBases
} from '../tasks/workspace-agent-selection'

export type NewWorktreeRuntimeSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
}

export type NewWorktreeAgentOption = {
  id: TuiAgent | '__blank__'
  label: string
  faviconDomain?: string
  isCustom?: boolean
  // Present only on custom rows: the base harness whose icon the row shows.
  baseAgent?: BuiltInTuiAgent
}

/** Picker options sourced from the host's env-free synced catalog, falling back to
 *  the static built-in rows when no snapshot is passed. Customs stay off until the
 *  identity-launch flip enables them (see `MobileAgentPickerOptions`). */
export function buildNewWorktreeAgentOptions(
  snapshot: AgentCatalogValue | null,
  options: MobileAgentPickerOptions = {}
): NewWorktreeAgentOption[] {
  return buildMobileAgentPickerRows(snapshot, options).map((row) => ({
    id: row.id,
    label: row.label,
    ...(row.faviconDomain ? { faviconDomain: row.faviconDomain } : {}),
    isCustom: row.isCustom,
    ...(row.baseAgent ? { baseAgent: row.baseAgent } : {})
  }))
}

export const NEW_WORKTREE_AGENT_OPTIONS: NewWorktreeAgentOption[] =
  buildNewWorktreeAgentOptions(null)

export const NEW_WORKTREE_BLANK_AGENT: NewWorktreeAgentOption = {
  id: '__blank__',
  label: 'Blank Terminal'
}

export function newWorktreeAgentOptionFor(
  id: string | null | undefined,
  snapshot: AgentCatalogValue | null = null
): NewWorktreeAgentOption {
  if (id === 'blank' || id === '__blank__') {
    return NEW_WORKTREE_BLANK_AGENT
  }
  // With a snapshot, resolve against the catalog rows so a custom id maps to its
  // real row (host label + base icon) instead of degrading to Blank.
  const options = snapshot
    ? buildNewWorktreeAgentOptions(snapshot, { includeCustomAgents: true })
    : NEW_WORKTREE_AGENT_OPTIONS
  return options.find((agent) => agent.id === id) ?? NEW_WORKTREE_BLANK_AGENT
}

// Ready + enabled customs from the catalog, keyed by id → base harness. The picker
// projection already excludes disabled/repair-required customs.
function customAgentBasesFrom(snapshot: AgentCatalogValue | null): WorkspaceCustomAgentBases {
  const bases = new Map<TuiAgent, BuiltInTuiAgent>()
  for (const row of buildMobileAgentPickerRows(snapshot, { includeCustomAgents: true })) {
    if (row.isCustom && row.baseAgent) {
      bases.set(row.id, row.baseAgent)
    }
  }
  return bases
}

export function pickPreferredNewWorktreeAgent(
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null,
  catalogSnapshot: AgentCatalogValue | null = null
): NewWorktreeAgentOption {
  // Why: the host's defaultTuiAgent may be a custom id; validating it against the
  // synced catalog keeps the un-overridden preview identical to the host's
  // default launch (which handleCreate defers to via selection kind 'default').
  return newWorktreeAgentOptionFor(
    pickWorkspaceAgent(
      {
        defaultTuiAgent: settings?.defaultTuiAgent,
        disabledTuiAgents: settings?.disabledTuiAgents
      },
      detectedAgentIds,
      customAgentBasesFrom(catalogSnapshot)
    ),
    catalogSnapshot
  )
}

/** Whether deferring to the host's stored default would launch the agent the picker
 *  previewed. Target detection narrows the preview but not the host's default, so a
 *  host default of `claude` on a target that only has `codex` previews Codex and
 *  would launch Claude; the caller must pin the preview instead. */
export function hostDefaultMatchesNewWorktreePreview(
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null,
  catalogSnapshot: AgentCatalogValue | null = null
): boolean {
  if (detectedAgentIds === null) {
    return true
  }
  return (
    pickPreferredNewWorktreeAgent(settings, detectedAgentIds, catalogSnapshot).id ===
    pickPreferredNewWorktreeAgent(settings, null, catalogSnapshot).id
  )
}

function isNewWorktreeAgentOptionSelectable(
  option: NewWorktreeAgentOption,
  detectedAgentIds: Set<string> | null,
  disabledTuiAgents: TuiAgent[] | undefined
): boolean {
  if (option.id === '__blank__') {
    return true
  }
  if (option.isCustom && option.baseAgent) {
    // Why: a custom agent's availability keys off its base harness — custom ids
    // never appear in the built-in detection set, so gating on the id would hide
    // every custom row and repair away a custom selection.
    return detectedAgentIds === null || detectedAgentIds.has(option.baseAgent)
  }
  if (!isMobileTuiAgentEnabled(option.id, disabledTuiAgents)) {
    return false
  }
  return detectedAgentIds === null || detectedAgentIds.has(option.id)
}

/** Picker rows sourced from the host's env-free synced catalog and narrowed to what
 *  is launchable on the target connection. Customs are gated on their base harness'
 *  detection; the projection already excludes disabled/repair-required customs. */
export function buildSelectableNewWorktreeAgentOptions(args: {
  snapshot: AgentCatalogValue | null
  includeCustomAgents: boolean
  detectedAgentIds: Set<string> | null
  disabledTuiAgents?: TuiAgent[]
}): NewWorktreeAgentOption[] {
  const { snapshot, includeCustomAgents, detectedAgentIds, disabledTuiAgents } = args
  return buildNewWorktreeAgentOptions(snapshot, { includeCustomAgents }).filter((option) =>
    isNewWorktreeAgentOptionSelectable(option, detectedAgentIds, disabledTuiAgents)
  )
}

/** Rows for the new-worktree agent picker: selectable catalog rows plus the blank
 *  terminal. Customs appear only when the host publishes a version:1 catalog (the
 *  identity-launch capability signal); the projection returns built-ins for a
 *  null/oversize snapshot, so unconditional inclusion stays a safe gate flip. */
export function buildNewWorktreePickerOptions(args: {
  snapshot: AgentCatalogValue | null
  detectedAgentIds: Set<string> | null
  disabledTuiAgents?: TuiAgent[]
}): NewWorktreeAgentOption[] {
  return [
    ...buildSelectableNewWorktreeAgentOptions({ ...args, includeCustomAgents: true }),
    NEW_WORKTREE_BLANK_AGENT
  ]
}

function isSelectableAgent(
  agent: NewWorktreeAgentOption,
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null
): boolean {
  return isNewWorktreeAgentOptionSelectable(agent, detectedAgentIds, settings?.disabledTuiAgents)
}

export function resolveNewWorktreeAgentSelection({
  visible,
  selectedAgent,
  agentOverridden,
  runtimeSettings,
  detectedAgentIds,
  catalogSnapshot = null
}: {
  visible: boolean
  selectedAgent: NewWorktreeAgentOption
  agentOverridden: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
  catalogSnapshot?: AgentCatalogValue | null
}): { selectedAgent: NewWorktreeAgentOption; agentOverridden: boolean } {
  if (!visible) {
    return { selectedAgent, agentOverridden }
  }

  const preferred = pickPreferredNewWorktreeAgent(
    runtimeSettings,
    detectedAgentIds,
    catalogSnapshot
  )
  if (!agentOverridden) {
    return { selectedAgent: preferred, agentOverridden: false }
  }

  if (
    detectedAgentIds !== null &&
    !isSelectableAgent(selectedAgent, runtimeSettings, detectedAgentIds)
  ) {
    return { selectedAgent: preferred, agentOverridden: false }
  }

  return { selectedAgent, agentOverridden: true }
}
