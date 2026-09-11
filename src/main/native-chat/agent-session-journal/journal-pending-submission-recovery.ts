import {
  DISPATCH_DOUBT_HOST_RESTARTED,
  DISPATCH_DOUBT_RETRY_IN_PROGRESS
} from './journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from './journal-store'

/** Settles every submission a process fact left unanswerable. The retry policy
 *  separately decides whether that fact proves the provider never received it.
 *
 *  A send the host was still HOLDING behind a running turn is not one of them:
 *  nothing was ever put on the wire, so it stays queued and the next host to
 *  own the session dispatches it rather than reporting delivery unconfirmed. */
export async function markJournalPendingSubmissionsUnknown(
  journal: AgentSessionJournal,
  fence: number,
  reason: string = DISPATCH_DOUBT_HOST_RESTARTED
): Promise<string[]> {
  const unresolved = journal
    .submissions()
    .filter(
      (entry) =>
        entry.queued !== true &&
        (entry.dispatchState === 'pending' ||
          (entry.dispatchState === 'unknown' && entry.recovered !== true))
    )
  for (const entry of unresolved) {
    const resolvedReason =
      entry.dispatchState === 'unknown' &&
      entry.reason !== null &&
      entry.reason !== DISPATCH_DOUBT_RETRY_IN_PROGRESS
        ? entry.reason
        : reason
    await journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'unknown',
      reason: resolvedReason,
      fence,
      recovered: true
    })
  }
  return unresolved.map((entry) => entry.clientMessageId)
}
