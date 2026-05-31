import type { TuiAgent } from '../../../src/shared/types'
import {
  filterEnabledMobileTuiAgents,
  isMobileTuiAgent,
  isMobileTuiAgentEnabled,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MOBILE_TUI_AGENT_LABELS,
  pickMobileTuiAgent
} from './mobile-tui-agents'

export type WorkspaceAgentChoice = TuiAgent | 'blank'

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
}

export function workspaceAgentLabel(agent: WorkspaceAgentChoice): string {
  return agent === 'blank' ? 'Blank Terminal' : MOBILE_TUI_AGENT_LABELS[agent]
}

export function normalizeWorkspaceAgent(value: unknown): WorkspaceAgentChoice | null {
  if (value === 'blank' || value === '__blank__') {
    return 'blank'
  }
  return isMobileTuiAgent(value) ? value : null
}

export function pickWorkspaceAgent(
  settings: WorkspaceAgentSettings,
  detectedAgentIds: Set<string> | null
): WorkspaceAgentChoice {
  const preferred = normalizeWorkspaceAgent(settings.defaultTuiAgent)
  if (preferred === 'blank') {
    return preferred
  }
  const disabled = settings.disabledTuiAgents
  const enabledAutoPickOrder = filterEnabledMobileTuiAgents(
    MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
    disabled
  )
  if (detectedAgentIds === null) {
    return preferred && isMobileTuiAgentEnabled(preferred, disabled)
      ? preferred
      : (enabledAutoPickOrder[0] ?? 'blank')
  }
  const detectedAgents = enabledAutoPickOrder.filter((agent) => detectedAgentIds.has(agent))
  return pickMobileTuiAgent(preferred, detectedAgents, disabled) ?? 'blank'
}

export function filterWorkspaceAgents(agents: readonly TuiAgent[], disabled?: unknown): TuiAgent[] {
  return filterEnabledMobileTuiAgents(agents, disabled)
}

export function isWorkspaceAgentEnabled(agent: TuiAgent, disabled?: unknown): boolean {
  return isMobileTuiAgentEnabled(agent, disabled)
}

export function resolveWorkspaceAgentSelection({
  selectionActive,
  settings,
  detectedAgentIds,
  agent,
  overridden
}: ResolveWorkspaceAgentSelectionArgs): WorkspaceAgentSelectionState {
  const current = { agent, overridden }
  if (!selectionActive) {
    return current
  }

  const pickedAgent = pickWorkspaceAgent(settings, detectedAgentIds)
  if (!overridden) {
    return agent === pickedAgent ? current : { agent: pickedAgent, overridden: false }
  }

  if (
    detectedAgentIds === null ||
    !agent ||
    agent === 'blank' ||
    (detectedAgentIds.has(agent) && isWorkspaceAgentEnabled(agent, settings.disabledTuiAgents))
  ) {
    return current
  }

  return { agent: pickedAgent, overridden: false }
}
