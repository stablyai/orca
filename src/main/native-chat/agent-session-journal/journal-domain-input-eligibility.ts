import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlCurrentWork } from './journal-sql-work-read'
import {
  journalDomainFirstQueuedInput,
  journalDomainEnteredInputs
} from './journal-domain-input-populations'
import {
  nextJournalDomainQueueCard,
  type JournalDomainQueuePick
} from './journal-domain-submission-consume'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlQueueFacts } from './journal-sql-queued-messages'

/** Send, automatic claim and publication derive the same barriers from current SQL rows. */
export function journalDomainInputEligibility(
  scope: JournalSqlScope,
  authority: JournalCurrentWorkAuthority
) {
  const row = scope.db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(scope.sessionId)
  const saved = row && scope.decode<unknown>(row.record_json)
  if (row && !isReadableAgentSessionStoreRecord(scope.sessionId, saved)) {
    throw new Error('input admission requires a readable session record')
  }
  const record = isReadableAgentSessionStoreRecord(scope.sessionId, saved)
    ? decodePersistedAgentSessionRecord(saved).record
    : null
  const blocked =
    !record || record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded'
  const context = new JournalSqlStatusContext(scope)
  const work = readJournalSqlCurrentWork(context, authority)
  const prompts = [...context.select({ kind: 'pending-prompts' })].flatMap(({ item }) => {
    const displayed = work.isCurrentItem(item.itemId) ? context.displayed(item.itemId) : null
    return displayed ? [displayed] : []
  })
  const pending = journalDomainFirstQueuedInput(scope)
  const entered = journalDomainEnteredInputs(scope)
  return {
    blocked,
    context,
    work,
    prompts,
    pending,
    handover: [...entered].some((send) => work.owesSend(send)),
    activeTurnId: work.activeTurn()?.turnId
  }
}

export function selectJournalEligibleQueueCard(
  scope: JournalSqlScope,
  authority: JournalCurrentWorkAuthority,
  now: number,
  facts: JournalSqlQueueFacts,
  allowSteer: boolean
): JournalDomainQueuePick & { steer: boolean; command: boolean } {
  const state = journalDomainInputEligibility(scope, authority)
  const none = { kind: 'selected' as const, card: null, steer: false, command: false }
  const steer = state.activeTurnId !== undefined
  if (
    state.blocked ||
    state.prompts.length > 0 ||
    state.pending ||
    state.handover ||
    (steer && !allowSteer)
  ) {
    return none
  }
  return {
    ...nextJournalDomainQueueCard(scope.db, scope, {
      reopenFloor: facts.reopenFloor,
      now,
      steer,
      automatic: true,
      mail: facts.mail
    }),
    steer,
    command: state.activeTurnId?.startsWith('compact:') === true
  }
}
