import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { translate } from '../../i18n/mobile-i18n'
import {
  filterEnabledMobileTuiAgents,
  isMobileTuiAgentEnabled
} from '../../agents/mobile-tui-agents'
import {
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '../../../../src/shared/agent-launch/catalog/quick-workspace-agent-selection'
import { isTuiAgent as isMobileTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES as MOBILE_TUI_AGENT_LABELS } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'

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
  resolvedDefaultAgent?: TuiAgent | null
}

export function workspaceAgentLabel(agent: WorkspaceAgentChoice): string {
  return agent === 'blank'
    ? translate('tasks.workspaceAgentSelection.blankTerminal', 'Blank Terminal')
    : MOBILE_TUI_AGENT_LABELS[agent]
}

export function normalizeWorkspaceAgent(value: unknown): WorkspaceAgentChoice | null {
  if (value === 'blank' || value === '__blank__') {
    return 'blank'
  }
  return isMobileTuiAgent(value) ? value : null
}

/** Desktop's quick-create pick; the phone has no chat offers yet, so every pick is a detected CLI. */
export function pickWorkspaceAgent(
  settings: WorkspaceAgentSettings,
  detectedAgentIds: Set<string> | null
): WorkspaceAgentChoice {
  return (
    pickQuickWorkspaceAgent(
      normalizeWorkspaceAgent(settings.defaultTuiAgent),
      detectedTuiAgents(detectedAgentIds),
      asDisabledList(settings.disabledTuiAgents)
    ) ?? 'blank'
  )
}

function detectedTuiAgents(detectedAgentIds: Set<string> | null): TuiAgent[] | null {
  return detectedAgentIds && [...detectedAgentIds].filter(isMobileTuiAgent)
}

function asDisabledList(disabled: unknown): unknown[] | null {
  return Array.isArray(disabled) ? disabled : null
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
  overridden,
  resolvedDefaultAgent
}: ResolveWorkspaceAgentSelectionArgs): WorkspaceAgentSelectionState {
  const current = { agent, overridden }
  if (!selectionActive) {
    return current
  }
  const pickedAgent =
    resolvedDefaultAgent === undefined
      ? pickWorkspaceAgent(settings, detectedAgentIds)
      : (resolvedDefaultAgent ?? 'blank')
  if (!overridden) {
    return agent === pickedAgent ? current : { agent: pickedAgent, overridden: false }
  }
  // Desktop's rule for keeping a user's choice; a blank terminal is its null override.
  const override = agent === 'blank' ? null : agent
  const { quickAgentOverride } = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride: override,
    preferredQuickAgent: pickedAgent === 'blank' ? null : pickedAgent,
    detectedAgentIds: detectedTuiAgents(detectedAgentIds),
    disabledTuiAgents: asDisabledList(settings.disabledTuiAgents)
  })
  return quickAgentOverride === override ? current : { agent: pickedAgent, overridden: false }
}
