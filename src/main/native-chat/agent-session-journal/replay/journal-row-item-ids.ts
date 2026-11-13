import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReadRow } from './journal-read-row'
import { isJournalStopOrResumeRow } from '../durable-rows/journal-row-schema'

/** The items one journal row can change, in the row's order: its items or mutations, and the
 *  sends a submission, dispatch or queue row names. Host-only Stop/Resume markers name none. */
export function journalRowItemIds(
  row: JournalReadRow,
  options: {
    canonical: (itemId: string) => string
    hasSubmission: (clientMessageId: string) => boolean
    queueSourceIds?: (messageId: string) => readonly string[]
  }
): string[] {
  if (row.kind === 'outcome') {
    return [
      ...row.itemIds.map(options.canonical),
      ...row.submissionIds.map((id) => agentJournalSubmissionKey(id))
    ]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.map((mutation) => options.canonical(mutation.itemId))
  }
  if (isJournalStopOrResumeRow(row)) {
    return []
  }
  if (row.kind === 'item' || row.kind === 'tombstone') {
    return [options.canonical(row.itemId)]
  }
  const ids =
    row.kind === 'queue'
      ? (options.queueSourceIds?.(row.messageId) ?? []).map((id) => agentJournalSubmissionKey(id))
      : []
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    return [...ids, agentJournalSubmissionKey(row.clientMessageId)]
  }
  // A queued card's row settles both the send it recovers and its own hand-off, each of which
  // can change how that send reads (`applyQueueRow`).
  if (row.kind === 'queue' && row.change.op === 'queued') {
    for (const id of new Set([row.change.recovers, row.change.attempt])) {
      if (id !== undefined && id !== null && options.hasSubmission(id)) {
        ids.push(agentJournalSubmissionKey(id))
      }
    }
  }
  return ids
}

/** The ids one row records, as written: before canonicalization, existence checks or
 *  visibility, repeats kept. Stable while the row exists, so a reader can address its slots.
 *  A queued card's row records the send it recovers, then its own hand-off. */
export function journalRowRawSlots(row: JournalReadRow): string[] {
  if (row.kind === 'outcome') {
    return [...row.itemIds, ...row.submissionIds.map((id) => agentJournalSubmissionKey(id))]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.map((mutation) => mutation.itemId)
  }
  if (isJournalStopOrResumeRow(row)) {
    return []
  }
  if (row.kind === 'item' || row.kind === 'tombstone') {
    return [row.itemId]
  }
  if (row.kind === 'submission' || row.kind === 'dispatch') {
    return [agentJournalSubmissionKey(row.clientMessageId)]
  }
  if (row.kind === 'queue' && row.change.op === 'queued') {
    return [row.change.recovers, row.change.attempt]
      .filter((id) => typeof id === 'string')
      .map((id) => agentJournalSubmissionKey(id))
  }
  return []
}
