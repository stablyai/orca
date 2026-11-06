import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from './journal-input-order'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'
import type { JournalWriterSession } from './journal-writer-session'

/** Today's opening effects over a persisted projection, each bounded by live work, legacy cards or
 *  pending sends: the projection already holds what a restore would rebuild. */
export async function openJournalWriterSession(
  session: JournalWriterSession
): Promise<AgentJournalCursor> {
  const { collaborators } = session
  for (const key of session.liveWorkItemKeys()) {
    const item = session.state.items.get(key)
    for (const revision of item ? staleSubagentRosterRevisions([item]) : []) {
      // Recovery revisions must not count as new provider output.
      await collaborators.itemAppender.append(revision.identity, revision.body, {
        fence: session.state.highestFence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        recovered: true
      })
    }
  }
  await collaborators.queuedMessages.importAtOpen()
  const { state } = session
  const openedThrough = { epoch: state.epoch, sequence: state.lastSequence }
  journalInputOrder(state).markOpeningRecovery()
  return openedThrough
}
