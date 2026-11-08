import { recordStructuredChatMessageDispatch } from '../../../telemetry/structured-chat-dispatch'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type Database from '../../../sqlite/sync-database'
import { journalInputCaller } from '../input-order/journal-input-provenance'
import { journalDispatchRowApplies } from '../projection/journal-dispatch-settlement'
import type { JournalReducerState } from '../projection/journal-reducer'

/** Observe settled transitions, including provider echoes, only after their transaction commits. */
export function prepareJournalDispatchTelemetry(
  db: Database.Database,
  identity: AgentSessionJournalIdentity,
  before: JournalReducerState,
  after: JournalReducerState,
  changedSubmissions: ReadonlySet<string>
): () => void {
  const settled = [...changedSubmissions].flatMap((id) => {
    const previous = before.submissions.get(id)
    const next = after.submissions.get(id)
    if (
      previous?.chatAction !== 'message' ||
      !journalDispatchRowApplies(previous) ||
      !next ||
      next.recovered ||
      (next.dispatchState !== 'accepted' && next.dispatchState !== 'rejected')
    ) {
      return []
    }
    const outcome = next.dispatchState
    return [
      () =>
        recordStructuredChatMessageDispatch(identity, outcome, () =>
          journalInputCaller(db, identity.sessionId, next)
        )
    ]
  })
  return () => settled.forEach((record) => record())
}
