import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import type { AgentSessionStopOutcome } from './structured-agent-session-adapter-stop'

/** Every Stop of one child revises one feedback note. */
export function structuredAgentSessionChildStopFeedbackId(
  child: StructuredAgentSessionProviderChildIdentity
): string {
  return `child:${child.fence}:${child.generation ?? 'unknown'}`
}

/**
 * A chat a switch stopped, once the switch proved its agent exited: the Stop's wind-down may have
 * noted it could not confirm the Stop before that proof. The exit is now proven, so that note goes;
 * a goal pause the agent never acknowledged is still unknown and keeps its own note.
 */
export async function settleSwitchProvenChatStop(input: {
  journal: AgentSessionJournal
  fence: number
  child: StructuredAgentSessionProviderChildIdentity
  pause?: AgentSessionStopOutcome['pause']
}): Promise<void> {
  const feedbackId = structuredAgentSessionChildStopFeedbackId(input.child)
  const identity = structuredAgentSessionStopNoteIdentity(feedbackId)
  if (input.journal.item(agentJournalItemKey(identity))?.body.kind !== 'status') {
    return
  }
  await input.journal.appendLifecycleBatch({
    settlementId: `switch-stop-proven:${feedbackId}`,
    fence: input.fence,
    mutations: [
      input.pause === 'unconfirmed'
        ? {
            kind: 'item',
            identity,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE,
            body: {
              kind: 'status',
              tone: 'warning',
              ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
                surface: 'row',
                stopNotice: 'pauseUnconfirmed'
              })
            }
          }
        : { kind: 'tombstone', identity }
    ]
  })
}
