import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from './input-order/journal-input-order'
import { staleSubagentRosterRevisions } from './item-lifecycle/journal-subagent-liveness'
import type { JournalWriterSession } from './journal-writer-session'
import { journalLogNeedsFounding } from './journal-sql-meta'
import { readJournalSessionEpoch } from './durable-rows/journal-row-table'

/** Today's opening effects over a persisted projection, each bounded by live work, legacy cards or
 *  pending sends: the projection already holds what a restore would rebuild. */
export async function openJournalWriterSession(
  session: JournalWriterSession
): Promise<AgentJournalCursor> {
  const { collaborators, db, sessionId } = session
  if (journalLogNeedsFounding(db, sessionId)) {
    collaborators.epochController.start(
      'session_created',
      0,
      readJournalSessionEpoch(db, sessionId)
    )
  }
  const restored = journalInputOrder(session.state)
  // Restore stamps cards before its frontier exists; a reopen re-derives both in that order.
  restored.lineage.reopen()
  restored.cards.reopen(session.state)
  restored.lineage.restoreFrontier(session.state.lastSequence, session.state.inputEntries)
  for (const key of liveWorkItemKeys(session)) {
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
  const order = journalInputOrder(state)
  order.markOpeningRecovery()
  order.newestTurn.reopen(state.lastSequence)
  return openedThrough
}

/** Items whose saved body still shows live work, in item map order. */
function liveWorkItemKeys(session: JournalWriterSession): string[] {
  return session.db
    .prepare(`SELECT entry_key FROM journal_proj_items INDEXED BY journal_proj_items_live_work
    WHERE session_id=? AND epoch=? AND live_work=1 ORDER BY ordinal`)
    .all(...session.scopePrefix())
    .map((row) => String(JSON.parse(String(row.entry_key))))
}
