import type { AgentStatus } from '../../shared/agent-title-core'

export function hasStructuredTuiIdleEvidence(input: {
  blocked: boolean
  status: AgentStatus | null
  statusObservedLive: boolean
}): boolean {
  return !input.blocked && input.status === 'idle' && input.statusObservedLive
}
