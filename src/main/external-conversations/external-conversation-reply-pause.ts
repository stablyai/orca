import type { JournalConnectorReplyCut } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import type { UsageLimitPause } from './external-conversation-reply-fill'

/** A usage-limit end whose automatic continue is pending (Phase 1 §1.5): its open rows become the
 *  cut's and the rows its own continuation claimed are cut again (N4), each keeping the failure for
 *  the cut's close. Any other disposition fills them as failed. */
export function usageLimitReplyPause(
  journal: () => ConnectorReplyCutJournal | null,
  disposition: (sessionId: string, turnItemId: string) => Promise<string | undefined>,
  /** When the scheduler shows its continue is due; none while it shows no time. */
  dueAt: (sessionId: string) => Promise<number | undefined> = async () => undefined
): UsageLimitPause {
  return async (turn, rows) => {
    const store = journal()
    if (!store || (await disposition(turn.sessionId, turn.turnItemId)) !== 'pending') {
      return false
    }
    const cut: JournalConnectorReplyCut = { turnId: turn.turnItemId, kind: 'usage_limit' }
    const open = rows.filter((row) => row.claimMessageId === undefined)
    if (open.length > 0) {
      const keys = open.map((row) => ({ account: row.account, deliveryId: row.deliveryId }))
      await store.cut(
        { keys, cut, ...(turn.failure ? { failure: turn.failure } : {}) },
        turn.current
      )
    }
    for (const claim of new Set(rows.flatMap((row) => row.claimMessageId ?? []))) {
      await store.recut(claim, cut, turn.failure, turn.current)
    }
    const resumesAt = await dueAt(turn.sessionId)
    return resumesAt === undefined ? {} : { resumesAt }
  }
}
