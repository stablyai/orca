import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import {
  filterEnabledMobileTuiAgents,
  isMobileTuiAgent,
  isMobileTuiAgentEnabled,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MOBILE_TUI_AGENT_LABELS,
  pickMobileTuiAgent
} from './mobile-tui-agents'

export type WorkspaceAgentChoice = TuiAgent | 'blank'

// Ready + enabled customs from the synced catalog, keyed by id; the value is the
// base harness whose detection gates the custom's availability (custom ids never
// appear in the built-in detection set).
export type WorkspaceCustomAgentBases = ReadonlyMap<TuiAgent, BuiltInTuiAgent>

type WorkspaceAgentSettings = {
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: unknown
}

export type WorkspaceAgentSelectionState = {
  agent: WorkspaceAgentChoice | null
  overridden: boolean
}

type ResolveWorkspaceAgentSelectionArgs = WorkspaceAgentSelectionState & {
  selectionActive: boolean
  settings: WorkspaceAgentSettings
  detectedAgentIds: Set<string> | null
  customAgentBases?: WorkspaceCustomAgentBases
}

export function workspaceAgentLabel(
  agent: WorkspaceAgentChoice,
  customAgentLabels?: ReadonlyMap<TuiAgent, string>
): string {
  if (agent === 'blank') {
    return 'Blank Terminal'
  }
  // Custom ids get their label from the synced catalog (later units); the
  // static parity table only knows built-ins.
  return isMobileTuiAgent(agent)
    ? MOBILE_TUI_AGENT_LABELS[agent]
    : (customAgentLabels?.get(agent) ?? agent)
}

export function normalizeWorkspaceAgent(
  value: unknown,
  customAgentBases?: WorkspaceCustomAgentBases
): WorkspaceAgentChoice | null {
  if (value === 'blank' || value === '__blank__') {
    return 'blank'
  }
  if (isMobileTuiAgent(value)) {
    return value
  }
  // A custom id is a valid preference only when the synced catalog vouches for it
  // (ready + enabled); otherwise the host default cannot be previewed and the
  // built-in auto-pick takes over.
  return typeof value === 'string' && customAgentBases?.has(value as TuiAgent)
    ? (value as TuiAgent)
    : null
}

export function pickWorkspaceAgent(
  settings: WorkspaceAgentSettings,
  detectedAgentIds: Set<string> | null,
  customAgentBases?: WorkspaceCustomAgentBases
): WorkspaceAgentChoice {
  const preferred = normalizeWorkspaceAgent(settings.defaultTuiAgent, customAgentBases)
  if (preferred === 'blank') {
    return preferred
  }
  const disabled = settings.disabledTuiAgents
  if (preferred && !isMobileTuiAgent(preferred)) {
    // Custom default: available while detection is pending or once its base
    // harness is detected — so the un-overridden preview matches the host's
    // default launch. Unavailable customs fall through to built-in auto-pick.
    const base = customAgentBases?.get(preferred)
    if (base && (detectedAgentIds === null || detectedAgentIds.has(base))) {
      return preferred
    }
  }
  const builtInPreferred = preferred && isMobileTuiAgent(preferred) ? preferred : null
  const enabledAutoPickOrder = filterEnabledMobileTuiAgents(
    MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
    disabled
  )
  if (detectedAgentIds === null) {
    return builtInPreferred && isMobileTuiAgentEnabled(builtInPreferred, disabled)
      ? builtInPreferred
      : (enabledAutoPickOrder[0] ?? 'blank')
  }
  const detectedAgents = enabledAutoPickOrder.filter((agent) => detectedAgentIds.has(agent))
  return pickMobileTuiAgent(builtInPreferred, detectedAgents, disabled) ?? 'blank'
}

export function filterWorkspaceAgents(agents: readonly TuiAgent[], disabled?: unknown): TuiAgent[] {
  return filterEnabledMobileTuiAgents(agents, disabled)
}

export function isWorkspaceAgentEnabled(agent: TuiAgent, disabled?: unknown): boolean {
  return isMobileTuiAgentEnabled(agent, disabled)
}

function isOverrideStillAvailable(
  agent: TuiAgent,
  settings: WorkspaceAgentSettings,
  detectedAgentIds: Set<string>,
  customAgentBases?: WorkspaceCustomAgentBases
): boolean {
  if (!isMobileTuiAgent(agent)) {
    // Custom availability keys off the base harness; the id itself never appears
    // in the detection set.
    const base = customAgentBases?.get(agent)
    return base != null && detectedAgentIds.has(base)
  }
  return detectedAgentIds.has(agent) && isWorkspaceAgentEnabled(agent, settings.disabledTuiAgents)
}

export function resolveWorkspaceAgentSelection({
  selectionActive,
  settings,
  detectedAgentIds,
  customAgentBases,
  agent,
  overridden
}: ResolveWorkspaceAgentSelectionArgs): WorkspaceAgentSelectionState {
  const current = { agent, overridden }
  if (!selectionActive) {
    return current
  }

  const pickedAgent = pickWorkspaceAgent(settings, detectedAgentIds, customAgentBases)
  if (!overridden) {
    return agent === pickedAgent ? current : { agent: pickedAgent, overridden: false }
  }

  if (
    detectedAgentIds === null ||
    !agent ||
    agent === 'blank' ||
    isOverrideStillAvailable(agent, settings, detectedAgentIds, customAgentBases)
  ) {
    return current
  }

  return { agent: pickedAgent, overridden: false }
}
