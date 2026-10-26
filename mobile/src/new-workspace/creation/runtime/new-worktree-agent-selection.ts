import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import { translate } from '../../../i18n/mobile-i18n'
import { MOBILE_AGENT_CATALOG } from '../../../agents/mobile-agent-catalog'
import {
  normalizeWorkspaceAgent,
  pickWorkspaceAgent,
  resolveWorkspaceAgentSelection
} from '../workspace-agent-selection'

export type NewWorktreeRuntimeSettings = {
  linkedWorkItemPromptTemplate?: string
  defaultTuiAgent?: TuiAgent | 'blank' | null
  disabledTuiAgents?: TuiAgent[]
}

export type NewWorktreeAgentOption = {
  id: TuiAgent | '__blank__'
  label: string
  faviconDomain?: string
}

const NEW_WORKTREE_AGENT_OPTIONS: NewWorktreeAgentOption[] = MOBILE_AGENT_CATALOG

export const NEW_WORKTREE_BLANK_AGENT: NewWorktreeAgentOption = {
  id: '__blank__',
  get label() {
    return translate('components.newWorktreeAgentSelection.blankTerminal', 'Blank Terminal')
  }
}

export function newWorktreeAgentOptionFor(id: string | null | undefined): NewWorktreeAgentOption {
  if (id === 'blank' || id === '__blank__') {
    return NEW_WORKTREE_BLANK_AGENT
  }
  return NEW_WORKTREE_AGENT_OPTIONS.find((agent) => agent.id === id) ?? NEW_WORKTREE_BLANK_AGENT
}

export function pickPreferredNewWorktreeAgent(
  settings: NewWorktreeRuntimeSettings | null,
  detectedAgentIds: Set<string> | null
): NewWorktreeAgentOption {
  return newWorktreeAgentOptionFor(
    pickWorkspaceAgent(
      {
        defaultTuiAgent: settings?.defaultTuiAgent,
        disabledTuiAgents: settings?.disabledTuiAgents
      },
      detectedAgentIds
    )
  )
}

export function resolveNewWorktreeAgentSelection({
  visible,
  selectedAgent,
  agentOverridden,
  runtimeSettings,
  detectedAgentIds
}: {
  visible: boolean
  selectedAgent: NewWorktreeAgentOption
  agentOverridden: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
}): { selectedAgent: NewWorktreeAgentOption; agentOverridden: boolean } {
  const agent = normalizeWorkspaceAgent(selectedAgent.id)
  const resolved = resolveWorkspaceAgentSelection({
    selectionActive: visible,
    settings: {
      defaultTuiAgent: runtimeSettings?.defaultTuiAgent,
      disabledTuiAgents: runtimeSettings?.disabledTuiAgents
    },
    detectedAgentIds,
    agent,
    overridden: agentOverridden
  })
  return {
    selectedAgent:
      resolved.agent === agent ? selectedAgent : newWorktreeAgentOptionFor(resolved.agent),
    agentOverridden: resolved.overridden
  }
}
