// Listed chats whose history is still in an older build's per-chat file have no stored status to
// list them from: the restart restore's own per-chat worker opens each one from its file before
// the tab listing answers, settles what a gone process left and publishes its status, and the
// restore after the listing skips it. A chat whose open fails costs only itself and stays listed.

import { readJournalSessionStatuses } from '../agent-session-journal/journal-session-state'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { hasHistoryOutsideJournalDatabase } from './structured-agent-session-read-restore'
import type {
  StructuredAgentSessionStartupLeases,
  StructuredAgentSessionStartupStateDeps
} from './structured-agent-session-startup-state'

// The listing waits for the whole pass, so a few at once: one slow file or recovery holds one lane.
const PRE_LISTING_RESTORE_CONCURRENCY = 4

/** Never rejects. `leases` resolves each chat's own lease only, so the listing waits on no other
 *  chat's recovery. */
export async function restoreListedFromPerChatFiles(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[],
  leases: StructuredAgentSessionStartupLeases
): Promise<void> {
  const database = deps.openDeps.journalDatabase
  // A newer build's database: the restore after the listing reads every listed chat as before.
  if (database.readOnly || deps.isDisposed()) {
    return
  }
  try {
    const inDatabase = new Set(
      readJournalSessionStatuses(database.db, listedIds).map(({ sessionId }) => sessionId)
    )
    const records = listedIds.flatMap((sessionId): AgentSessionRecord[] => {
      const record = inDatabase.has(sessionId) ? null : deps.openDeps.store.getRecord(sessionId)
      return record &&
        deps.canSettle(record) &&
        !deps.hasSession(sessionId) &&
        hasHistoryOutsideJournalDatabase(database, record)
        ? [record]
        : []
    })
    if (records.length > 0) {
      await deps.restoreListed(records, leases, PRE_LISTING_RESTORE_CONCURRENCY)
    }
  } catch (error) {
    deps.openDeps.logger.warn('restoring chats still in per-chat files at startup failed', {
      scope: 'startup-per-chat-file-restore',
      error
    })
  }
}
