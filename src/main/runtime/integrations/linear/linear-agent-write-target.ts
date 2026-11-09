import type { LinearIssueSummary } from '../../../../shared/linear/agent-result-types'

export type LinearAgentWriteTarget = {
  issue: LinearIssueSummary
  workspaceId: string
}
