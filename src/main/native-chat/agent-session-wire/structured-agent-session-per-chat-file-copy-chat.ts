// One chat's copy, inside that chat's host serialize. A chat a restore opened from its old file
// copies through its own owed import, in its write queue; any other through the importer, handed
// the copy's yield and the signal that stops it at quit or at a chat's next provider frame.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { timedJournalImportPages } from '../agent-session-journal/journal-import-page'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import type { PerChatFileCopyDeps } from './structured-agent-session-per-chat-file-copy'
import { settleWrittenChat } from './structured-agent-session-status-backfill-step'

/** How the chat's file ended: copied, kept aside, or deleted as already copied. */
export type PerChatFileCopyOutcome = 'copied' | 'setAside' | 'deleted'

export async function copyPerChatFileUnderSerialize(
  deps: Pick<
    PerChatFileCopyDeps,
    'database' | 'store' | 'openJournal' | 'settleClosedChat' | 'logger' | 'importJournal'
  >,
  record: AgentSessionRecord,
  legacyDirectory: string,
  { yieldTask, signal }: { yieldTask: () => Promise<void>; signal: AbortSignal }
): Promise<PerChatFileCopyOutcome> {
  const { sessionId } = record
  const open = deps.openJournal(sessionId)
  if (open?.importPending) {
    // Previewed by a restore: the copy is that chat's own owed import, run in its write queue.
    // Its wall time is charged, whoever started it; the debt is paid between chats.
    await open.whenImported({ signal })
    return 'copied'
  }
  // The identity an open builds, from the record.
  const identity = journalIdentityFor(
    record,
    attachParamsForRecord(record, {
      clientOperationId: `per-chat-file-copy:${sessionId}`,
      expectedRuntimeFence: record.lease.runtimeFence
    })
  )
  const result = await (deps.importJournal ?? importPerSessionJournal)({
    database: deps.database,
    identity,
    legacyDirectory,
    yieldTask,
    signal,
    // The job's own work: its pages follow its tasks' time.
    pages: timedJournalImportPages
  })
  // An older build left it with work: settled now, from the copy's fold, so no later startup
  // opens it. A failed or stopped settle is not a failed copy: startup settles the row it wrote.
  const { load, status } = result
  if (!open && load && status && !signal.aborted) {
    await settleWrittenChat(deps, sessionId, { load, status })
  }
  return result.outcome === 'imported'
    ? 'copied'
    : result.outcome === 'kept'
      ? 'setAside'
      : 'deleted'
}
