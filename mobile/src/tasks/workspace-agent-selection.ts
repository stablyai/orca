import type { TuiAgent } from '../../../src/shared/types'
import {
  isMobileTuiAgent,
  MOBILE_TUI_AGENT_AUTO_PICK_ORDER,
  MOBILE_TUI_AGENT_LABELS,
  pickMobileTuiAgent
} from './mobile-tui-agents'

export type WorkspaceAgentChoice = TuiAgent | 'blank'

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
  settings: { defaultTuiAgent?: TuiAgent | 'blank' | null },
  detectedAgentIds: Set<string> | null
): WorkspaceAgentChoice {
  const preferred = normalizeWorkspaceAgent(settings.defaultTuiAgent)
  if (preferred === 'blank') {
    return preferred
  }
  if (detectedAgentIds === null) {
    return preferred ?? MOBILE_TUI_AGENT_AUTO_PICK_ORDER[0] ?? 'blank'
  }
  const detectedAgents = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.filter((agent) =>
    detectedAgentIds.has(agent)
  )
  return pickMobileTuiAgent(preferred, detectedAgents) ?? 'blank'
}
