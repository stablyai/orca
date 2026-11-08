import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/agent-session/failures/structured-agent-session-start-failure-row-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from './journal-lifecycle-mutation'

/** Deduplicate durable failure by child generation, or oldest opening message if no child published. */
export function journalStartFailureRow(
  startKey: string,
  words: AgentJournalDispatchRejection
): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: structuredAgentSessionStartFailureRowIdentity(startKey),
    body: { kind: 'status', text: words.reason, tone: 'error', failure: words.rejection },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}
