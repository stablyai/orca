import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlCurrentWork } from './journal-sql-work-read'
import { readJournalSqlInput } from './journal-sql-input-reads'
import {
  nextJournalDomainQueueCard,
  type JournalDomainQueuePick
} from './journal-domain-submission-consume'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalAutomaticSelection } from './journal-automatic-submission'
import type { JournalSqlQueueFacts } from './journal-sql-queued-messages'

/** Current work and ordered cards are decided at the same fixed edit-hold instant. */
export function selectJournalAutomaticSubmission(
  scope: JournalSqlScope,
  selection: JournalAutomaticSelection,
  now: number,
  facts: JournalSqlQueueFacts
): JournalDomainQueuePick & { steer: boolean; command: boolean } {
  const none = { kind: 'selected' as const, card: null, steer: false, command: false }
  const row = scope.db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(scope.sessionId)
  if (!row) {
    return none
  }
  const saved = scope.decode<unknown>(row.record_json)
  if (!isReadableAgentSessionStoreRecord(scope.sessionId, saved)) {
    throw new Error('automatic submission requires a readable session record')
  }
  const { record } = decodePersistedAgentSessionRecord(saved)
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return none
  }
  const context = new JournalSqlStatusContext(scope)
  const work = readJournalSqlCurrentWork(context, selection.authority)
  const actionable = [...context.select({ kind: 'pending-prompts' })].some(
    ({ item }) => work.isCurrentItem(item.itemId) && context.displayed(item.itemId) !== null
  )
  const pending = readJournalSqlInput(scope, { kind: 'first-queued' })
  if (actionable || (pending.kind === 'first-queued' && pending.submission)) {
    return none
  }
  const activeTurnId = work.activeTurn()?.turnId
  const entered = readJournalSqlInput(scope, { kind: 'entered-submissions' })
  const handover =
    entered.kind === 'entered-submissions' &&
    entered.submissions.some((send) => work.owesSend(send))
  if (handover) {
    return none
  }
  const steer = activeTurnId !== undefined
  return {
    ...nextJournalDomainQueueCard(scope.db, scope, {
      reopenFloor: facts.reopenFloor,
      now,
      steer,
      automatic: true,
      mail: facts.mail
    }),
    steer,
    command: activeTurnId?.startsWith('compact:') === true
  }
}
