import { useState } from 'react'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import {
  NEW_WORKTREE_AGENT_OPTIONS,
  NEW_WORKTREE_BLANK_AGENT,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'

export function useNewWorkspaceAgentSelection(args: {
  visible: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
  resolvedDefaultAgent?: TuiAgent | null
}): {
  selectedAgent: NewWorktreeAgentOption
  agentOverridden: boolean
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  pickerAgentOptions: NewWorktreeAgentOption[]
} {
  const [selectedAgentState, setSelectedAgent] = useState<NewWorktreeAgentOption>(
    NEW_WORKTREE_AGENT_OPTIONS[0]!
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const resolution = resolveNewWorktreeAgentSelection({
    visible: args.visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings: args.runtimeSettings,
    detectedAgentIds: args.detectedAgentIds,
    resolvedDefaultAgent: args.resolvedDefaultAgent
  })
  if (
    selectedAgentState.id !== resolution.selectedAgent.id ||
    agentOverriddenState !== resolution.agentOverridden
  ) {
    setSelectedAgent(resolution.selectedAgent)
    setAgentOverridden(resolution.agentOverridden)
  }
  const visibleAgentOptions = NEW_WORKTREE_AGENT_OPTIONS.filter(
    (agent) =>
      agent.id !== '__blank__' &&
      (args.detectedAgentIds === null || args.detectedAgentIds.has(agent.id)) &&
      isMobileTuiAgentEnabled(agent.id, args.runtimeSettings?.disabledTuiAgents)
  )
  return {
    selectedAgent: resolution.selectedAgent,
    agentOverridden: resolution.agentOverridden,
    setSelectedAgent,
    setAgentOverridden,
    pickerAgentOptions: [...visibleAgentOptions, NEW_WORKTREE_BLANK_AGENT]
  }
}
