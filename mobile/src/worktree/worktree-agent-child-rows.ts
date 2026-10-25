import { decodeAgentChildWorkViews } from '../../../src/shared/agent-status-child-work-view-wire'
import { decodeAgentSubagentsField } from '../../../src/shared/agent-status-subagent-snapshot'
import { buildRunningAgentChildRowModels } from '../../../src/shared/running-agent-child-rows'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

/** Read the optional catalog fields permissively, including hosts with no child roster. */
export function worktreeAgentChildRows(agent: RuntimeWorktreeAgentRow, live: boolean) {
  return buildRunningAgentChildRowModels(
    {
      children: decodeAgentChildWorkViews(agent.children),
      subagents: decodeAgentSubagentsField(agent.subagents)
    },
    {
      parentEvidenceFresh: agent.subagentObservation === 'live',
      transportObservation: live ? 'live' : 'unverifiable',
      parentObservedAt: agent.updatedAt,
      hostClockOffsetMs: 0
    }
  )
}
