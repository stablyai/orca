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
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { orchestrationMailNotice } from '../../../shared/agent-session/journal/agent-session-message-source'

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
    handover: journalHandover(
      context,
      [...context.enteredSubmissions()].filter((send) => work.owesSend(send))
    ),
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
    handover: journalHandover(context, work.owedEnteredSubmissions),
    activeTurnId: work.activeTurn?.turnId
  }
}

/** Sends the agent has not taken in yet; other agents' mail alone never holds the next mail card,
 *  since a running turn takes every waiting message in at its next step. */
function journalHandover(
  context: JournalSqlStatusContext,
  owed: readonly AgentJournalSubmission[]
): 'none' | 'mail' | 'input' {
  if (owed.length === 0) {
    return 'none'
  }
  return owed.every((send) => {
    const body = context.item(agentJournalSubmissionKey(send.clientMessageId))?.body
    return body?.kind === 'message' && orchestrationMailNotice(body.from) !== null
  })
    ? 'mail'
    : 'input'
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
  if (
    state.blocked ||
    state.prompts.length > 0 ||
    state.pending ||
    (state.handover !== 'none' && !(steer && state.handover === 'mail')) ||
    (steer && !allowSteer)
  ) {
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
        mailOnly: state.handover === 'mail'
      },
      state.context.inputHead
    ),
    steer,
    command: state.activeTurnId?.startsWith('compact:') === true
  }
}
