import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import type { JournalCurrentWorkAuthority, JournalObserverResult } from './journal-observer-read'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlCurrentWork } from './journal-sql-current-work'
import {
  nextJournalDomainQueueCard,
  type JournalDomainQueuePick
} from './journal-domain-submission-consume'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlQueueFacts } from './journal-sql-queued-messages'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

const MAX_OWED_MAIL_STEERS = 32

/** Send, automatic claim and publication derive the same barriers from current SQL rows. */
export function journalDomainInputEligibility(
  scope: JournalSqlScope,
  authority: JournalCurrentWorkAuthority,
  context = new JournalSqlStatusContext(scope),
  work = readJournalSqlCurrentWork(context, authority)
) {
  const blocked = journalDomainInputRecordBlocked(scope, context)
  const prompts = [...context.select({ kind: 'pending-prompts' })].flatMap(({ item }) => {
    const displayed = work.isCurrentItem(item.itemId) ? context.displayed(item.itemId) : null
    return displayed ? [displayed] : []
  })
  return {
    blocked,
    context,
    work,
    prompts,
    pending: context.firstQueuedInput(),
    handover: [...context.enteredSubmissions()].filter((send) => work.owesSend(send)),
    activeTurnId: work.activeTurn()?.turnId
  }
}

function journalDomainInputRecordBlocked(scope: JournalSqlScope, context: JournalSqlStatusContext) {
  const row =
    context.inputHead ??
    scope.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
      .get(scope.sessionId)
  const saved = row?.record_json == null ? null : scope.decode<unknown>(row.record_json)
  if (row?.record_json != null && !isReadableAgentSessionStoreRecord(scope.sessionId, saved)) {
    throw new Error('input admission requires a readable session record')
  }
  const record = isReadableAgentSessionStoreRecord(scope.sessionId, saved)
    ? decodePersistedAgentSessionRecord(saved).record
    : null
  return (
    !record || record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded'
  )
}

/** A validated work answer already owns prompt, handover and active-turn policy. */
export function journalDomainResolvedInputEligibility(
  context: JournalSqlStatusContext,
  work: JournalObserverResult['work']
) {
  return {
    blocked: journalDomainInputRecordBlocked(context.scope, context),
    context,
    prompts: work.actionablePrompts,
    pending: context.firstQueuedInput(),
    handover: work.owedEnteredSubmissions,
    activeTurnId: work.activeTurn?.turnId
  }
}

/** Claude and Codex take every waiting message in at their next step, so other agents' mail the
 *  agent has not taken in yet never holds the next mail card, up to a bound below the smallest
 *  provider's limit on sends awaiting their echo. */
function owedSendsAreMail(
  scope: JournalSqlScope,
  owed: readonly AgentJournalSubmission[]
): boolean {
  if (owed.length >= MAX_OWED_MAIL_STEERS) {
    return false
  }
  const notice = scope.db
    .prepare(`SELECT json_extract(payload_json,'$.body.from.orchestration.message')
    AS notice FROM journal_queue_cards WHERE session_id=? AND epoch=? AND message_id=?`)
  return owed.every(
    (send) =>
      send.queuedMessageId !== undefined &&
      notice.get(scope.sessionId, scope.epoch, send.queuedMessageId)?.notice === 'mail-notice'
  )
}

export function selectJournalEligibleQueueCard(
  scope: JournalSqlScope,
  authority: JournalCurrentWorkAuthority,
  now: number,
  facts: JournalSqlQueueFacts,
  allowSteer: boolean,
  resolved?: Omit<ReturnType<typeof journalDomainInputEligibility>, 'work'>
): JournalDomainQueuePick & { steer: boolean; command: boolean } {
  const state = resolved ?? journalDomainInputEligibility(scope, authority)
  const none = { kind: 'selected' as const, card: null, steer: false, command: false }
  const steer = state.activeTurnId !== undefined
  if (state.blocked || state.prompts.length > 0 || state.pending || (steer && !allowSteer)) {
    return none
  }
  const mailOnly = state.handover.length > 0
  if (mailOnly && !(steer && owedSendsAreMail(scope, state.handover))) {
    return none
  }
  return {
    ...nextJournalDomainQueueCard(
      scope.db,
      scope,
      {
        reopenFloor: facts.reopenFloor,
        now,
        steer,
        automatic: true,
        mail: facts.mail,
        mailOnly
      },
      state.context.inputHead
    ),
    steer,
    command: state.activeTurnId?.startsWith('compact:') === true
  }
}
