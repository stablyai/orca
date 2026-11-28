import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { useState } from 'react'
import { isMobileTuiAgentEnabled } from '../../../agents/mobile-tui-agents'
import {
  NEW_WORKTREE_BLANK_AGENT,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'
import { MOBILE_AGENT_CATALOG as NEW_WORKTREE_AGENT_OPTIONS } from '../../../agents/mobile-agent-catalog'

export function useNewWorkspaceAgentSelection(args: {
  visible: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
}): {
  selectedAgent: NewWorktreeAgentOption
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  pickerAgentOptions: NewWorktreeAgentOption[]
} {
  const t = useMobileTranslation()
  const [selectedAgentState, setSelectedAgent] = useState<NewWorktreeAgentOption>(
    NEW_WORKTREE_AGENT_OPTIONS[0]!
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const resolution = resolveNewWorktreeAgentSelection({
    visible: args.visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings: args.runtimeSettings,
    detectedAgentIds: args.detectedAgentIds
  })
  if (
    selectedAgentState.id !== resolution.selectedAgent.id ||
    agentOverriddenState !== resolution.agentOverridden
  ) {
    setSelectedAgent(resolution.selectedAgent)
    setAgentOverridden(resolution.agentOverridden)
  }
  const visibleAgentOptions = NEW_WORKTREE_AGENT_OPTIONS.filter(
    (agent: NewWorktreeAgentOption) =>
      agent.id !== '__blank__' &&
      (args.detectedAgentIds === null || args.detectedAgentIds.has(agent.id)) &&
      isMobileTuiAgentEnabled(agent.id, args.runtimeSettings?.disabledTuiAgents)
  )
  const blankAgent = {
    ...NEW_WORKTREE_BLANK_AGENT,
    label: t('components.newWorktreeAgentSelection.blankTerminal', 'Blank Terminal')
  }
  return {
    selectedAgent:
      resolution.selectedAgent.id === '__blank__' ? blankAgent : resolution.selectedAgent,
    setSelectedAgent,
    setAgentOverridden,
    pickerAgentOptions: [...visibleAgentOptions, blankAgent]
  }
}
