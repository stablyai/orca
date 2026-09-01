import { useState } from 'react'
import {
  buildNewWorktreePickerOptions,
  NEW_WORKTREE_AGENT_OPTIONS,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'

export function useNewWorkspaceAgentSelection(args: {
  visible: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
  agentCatalog: AgentCatalogValue | null
}): {
  selectedAgent: NewWorktreeAgentOption
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  agentOverridden: boolean
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
    catalogSnapshot: args.agentCatalog
  })
  if (
    selectedAgentState.id !== resolution.selectedAgent.id ||
    agentOverriddenState !== resolution.agentOverridden
  ) {
    setSelectedAgent(resolution.selectedAgent)
    setAgentOverridden(resolution.agentOverridden)
  }
  const pickerAgentOptions = buildNewWorktreePickerOptions({
    snapshot: args.agentCatalog,
    detectedAgentIds: args.detectedAgentIds,
    disabledTuiAgents: args.runtimeSettings?.disabledTuiAgents
  })
  return {
    selectedAgent: resolution.selectedAgent,
    setSelectedAgent,
    setAgentOverridden,
    agentOverridden: resolution.agentOverridden,
    pickerAgentOptions
  }
}
