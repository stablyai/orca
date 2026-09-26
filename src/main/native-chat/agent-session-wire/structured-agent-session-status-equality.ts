// When two status projections of one session are the same row to a reader, so a re-projection
// that changes nothing a list shows is not re-sent.

import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-lead-status-fold'
import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'

export function structuredAgentSessionSummariesEqual(
  a: AgentSessionStatusSummary,
  b: AgentSessionStatusSummary
): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agent === b.agent &&
    a.status === b.status &&
    a.hostExecutionOwned === b.hostExecutionOwned &&
    a.hostExecutionPhase === b.hostExecutionPhase &&
    a.rewindBlockedReason === b.rewindBlockedReason &&
    // A moved state clock changes ranking; row activity alone, including a subagent's, does not.
    // An idle state the journal cannot date still republishes, since readers date it by `updatedAt`,
    // and so does one live child work holds open: readers take each publish as its evidence.
    a.statusStartedAt === b.statusStartedAt &&
    (a.status !== 'idle' ||
      a.updatedAt === b.updatedAt ||
      (a.statusStartedAt !== undefined && !isIdleHeldOpenByChildWork(b))) &&
    a.latestPrompt === b.latestPrompt &&
    a.model === b.model &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.turnOutcome === b.turnOutcome &&
    agentSessionBackgroundTasksEqual(a.backgroundTasks, b.backgroundTasks) &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}

function isIdleHeldOpenByChildWork(summary: AgentSessionStatusSummary): boolean {
  return (
    summary.status === 'idle' &&
    isAgentStatusHeldOpenByChildWork(
      structuredAgentSessionAgentStatus({
        status: summary.status,
        backgroundTasks: summary.backgroundTasks,
        turnOutcome: summary.turnOutcome
      })
    )
  )
}
