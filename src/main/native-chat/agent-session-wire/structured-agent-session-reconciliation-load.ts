// The reconciliation worker's own read of a chat nobody has open: replayed outside the chat's lane,
// and never indexed as the chat's conversation, so what its pass writes reaches no reader and no
// status surface. A reader that opens the chat replays it fresh; the worker then uses theirs.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readJournalRowsAfter,
  readJournalSessionEpoch
} from '../agent-session-journal/journal-row-table'
import { isJournalOpenFailurePermanent } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionConversationOpenDeps } from './structured-agent-session-conversation-open'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

export type StructuredAgentSessionReconciliationLoad =
  | { kind: 'loaded'; session: StructuredAgentSessionHostSession }
  /** Opened by a reader meanwhile, or quitting: nothing read. */
  | { kind: 'skipped' }
  /** Nothing owed: no journal (nothing was ever written), or one damaged or written by a newer Orca,
   *  which no retry reads (reported once here). */
  | { kind: 'nothing' }

/** Replays a closed chat's journal, for a caller in a background slot. Throws only a failure that
 *  can clear. `skip`: read once the turn comes, so a reader's open meanwhile wins. */
export async function loadStructuredAgentSessionForReconciliation(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string,
  skip: () => boolean
): Promise<StructuredAgentSessionReconciliationLoad> {
  // A replay is synchronous SQLite: a macrotask before each keeps a send or a read from waiting
  // behind a whole scan's worth of them.
  await yieldToEventLoop()
  if (skip()) {
    return { kind: 'skipped' }
  }
  try {
    const opened = await restoreStructuredAgentSessionRead(deps, sessionId)
    return opened ? { kind: 'loaded', session: opened.session } : { kind: 'nothing' }
  } catch (error) {
    if (!isJournalOpenFailurePermanent(error)) {
      throw error
    }
    deps.logger.warn("a chat's history cannot be loaded, so nothing is settled", {
      scope: 'reconciliation',
      sessionId,
      error
    })
    return { kind: 'nothing' }
  }
}

/** Whether a handle still holds the journal's newest row: another handle (a reader that opened,
 *  wrote and closed the chat meanwhile) leaves it stale, and a stale handle must not write. */
export function structuredAgentSessionJournalIsCurrent(
  deps: StructuredAgentSessionConversationOpenDeps,
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'cursor'>
): boolean {
  const { db } = deps.journalDatabase
  const { epoch, sequence } = journal.cursor()
  return (
    readJournalSessionEpoch(db, sessionId) === epoch &&
    readJournalRowsAfter(db, sessionId, epoch, sequence, 1).length === 0
  )
}
