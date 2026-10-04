// Which status-summary changes reach every session list. The summary is broadcast to remote
// subscribers too, so only a change a session list shows may re-send it.

import { agentProviderSessionsEqual } from '../../../shared/agent-session-resume'
import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { isAgentStatusHeldOpenByChildWork } from '../../../shared/agent-lead-status-fold'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { structuredStatusChildrenEqual } from './structured-agent-session-status-child-work'

export function structuredStatusSummariesEqual(
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
    structuredStatusChildrenEqual(a.children, b.children) &&
    agentProviderSessionsEqual(undefined, a.providerSession, b.providerSession)
  )
}

/** Held open by the host's child records, read the way every row reads them. */
function isIdleHeldOpenByChildWork(summary: AgentSessionStatusSummary): boolean {
  return (
    summary.status === 'idle' &&
    isAgentStatusHeldOpenByChildWork(
      structuredAgentSessionAgentStatus({
        status: summary.status,
        childWork: summary.children ?? summary.backgroundTasks,
        turnOutcome: summary.turnOutcome
      })
    )
  )
}
