import { readJournalSqlCurrentWork } from './journal-sql-current-work'
export { readJournalSqlCurrentWork } from './journal-sql-current-work'
import {
  journalDomainInputEligibility,
  selectJournalEligibleQueueCard
} from './journal-domain-input-eligibility'
import { journalSqlFailure } from './journal-sql-failure'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestStructuredAgentSessionTurn } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import type { StructuredAgentSessionWorkPolicy } from '../agent-session-wire/observations/structured-agent-session-work-policy'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalCurrentWorkAuthority, JournalObserverResult } from './journal-observer-read'
import type {
  JournalSqlWorkRead,
  JournalSqlWorkResult,
  JournalWorkRead,
  JournalWorkReadResult
} from './journal-work-read'
import { journalInputAttemptEndedFromFacts } from './input-order/journal-input-attempt-ended'
import { readJournalSqlInput } from './journal-sql-input-reads'

/** The same finished work state serves observers and action readers. */
export function readJournalSqlWorkState(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy
): JournalObserverResult['work'] {
  const boundary = context.select({ kind: 'boundary' })[Symbol.iterator]().next().value?.item
  const actionablePrompts = [...context.select({ kind: 'pending-prompts' })].flatMap(({ item }) => {
    const displayed = work.isCurrentItem(item.itemId) ? context.displayed(item.itemId) : null
    return displayed ? [displayed] : []
  })
  const floor = context.commandFloor()
  const owed = context
    .recoverableSubmissions()
    .filter((send) => (floor === 0 || (send.acceptedSequence ?? 0) > floor) && work.owesSend(send))
  return {
    commandAdmission: {
      promptPending: actionablePrompts.some((item) => item.sequence > floor),
      owesSend: owed.length > 0,
      handoverOwesSend: owed.some((send) => !isQueuedAgentJournalSubmission(send))
    },
    liveFence: work.liveFence,
    allowsObservation: work.allowsObservation(),
    working: work.working(),
    owesAnySend: work.owesAnySend(),
    owedEnteredSubmissions: owedPhaseSubmissions(context, work, 'entered-submissions'),
    owedSendingSubmissions: owedPhaseSubmissions(context, work, 'sending-submissions'),
    activeTurn: work.activeTurn(),
    latestTurn: work.publishedLatestTurn(
      latestStructuredAgentSessionTurn(boundary ? [boundary] : [])
    ),
    actionablePrompts,
    restatedSubmissions: work.restatedSubmissions(),
    viewKey: work.viewKey(),
    workViewKey: work.workViewKey()
  }
}

function owedPhaseSubmissions(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy,
  kind: 'entered-submissions' | 'sending-submissions'
) {
  const submissions =
    kind === 'entered-submissions' ? context.enteredSubmissions() : context.sendingSubmissions()
  return submissions.filter((send) => work.owesSend(send))
}

export function readJournalSqlWork(
  context: JournalSqlStatusContext,
  input: JournalSqlWorkRead
): JournalSqlWorkResult {
  if (input.operation.kind === 'state' || input.operation.kind === 'input') {
    context.prepareWork()
  }
  const work = readJournalSqlCurrentWork(context, input.authority)
  return {
    cursor: { epoch: context.epoch, sequence: context.sequence },
    physicalCursor: { epoch: context.scope.epoch, sequence: context.sequence },
    authority: input.authority,
    result: readWork(context, work, input.operation, input.authority)
  }
}

function readWork(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy,
  operation: JournalWorkRead,
  authority: JournalCurrentWorkAuthority
): JournalWorkReadResult {
  switch (operation.kind) {
    case 'input': {
      const state = readJournalSqlWorkState(context, work)
      return readJournalSqlWorkInput(context, authority, operation, state, () =>
        journalDomainInputEligibility(context.scope, authority, context, work)
      )
    }
    case 'opening-send':
      return { kind: 'opening-send', opening: journalOpeningSend(context, work, operation.fence) }
    case 'state':
      return { kind: 'state', state: readJournalSqlWorkState(context, work) }
    case 'turn':
      return { kind: 'turn', activeTurn: work.activeTurn(), working: work.working() }
    case 'child-work': {
      const newest = readJournalSqlInput(context.scope, { kind: 'newest-turn' })
      if (newest.kind !== 'newest-turn') {
        throw new Error('journal newest turn read returned a different answer')
      }
      return {
        kind: 'child-work',
        working: work.working(),
        activeTurn: work.activeTurn() !== null,
        actionablePrompt: [...context.select({ kind: 'pending-prompts' })].some(
          ({ item }) => work.isCurrentItem(item.itemId) && context.displayed(item.itemId) !== null
        ),
        newestTurnCompletedAt: newest.turn?.completedAt
      }
    }
    case 'item':
      return { kind: 'item', current: work.isCurrentItem(operation.itemId) }
    case 'send':
      return {
        kind: 'send',
        generationEnded: work.generationEnded(operation.submission),
        owesSend: work.owesSend(operation.submission),
        handsOver: work.handsOver(operation.submission),
        published: work.publishedSubmission(operation.submission)
      }
    case 'attempt-ended': {
      const send = context.submission(operation.clientMessageId)
      const facts = context.inputAttempt(operation.clientMessageId)
      return {
        kind: 'attempt-ended',
        ended:
          send !== undefined &&
          journalInputAttemptEndedFromFacts(send, work, {
            fence: facts.fence ?? send.fence,
            ended: facts.ended
          })
      }
    }
  }
}

/** Mandatory work survives the existing optional queue publication boundary. */
export function readJournalSqlWorkInput(
  context: JournalSqlStatusContext,
  authority: JournalCurrentWorkAuthority,
  operation: Extract<JournalWorkRead, { kind: 'input' }>,
  state: JournalObserverResult['work'],
  eligibility: () => Omit<ReturnType<typeof journalDomainInputEligibility>, 'work'>
): Extract<JournalWorkReadResult, { kind: 'input' }> {
  try {
    const pick = selectJournalEligibleQueueCard(
      context.scope,
      authority,
      operation.now,
      operation.facts,
      operation.allowSteer,
      eligibility()
    )
    return { kind: 'input', state, queue: { card: pick.kind === 'selected' ? pick.card : null } }
  } catch (error) {
    return { kind: 'input', state, queue: { failure: journalSqlFailure(error) } }
  }
}

/** Only pending handovers and the newest raw root turn can hold a subsequent send. */
function journalOpeningSend(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy,
  fence: number
): boolean {
  const pending = context
    .recoverableSubmissions()
    .filter(
      (send) =>
        send.dispatchState === 'pending' &&
        send.handedOverAt !== undefined &&
        send.fence === fence &&
        work.owesSend(send)
    )
  if (pending.length === 0) {
    return false
  }
  const row = context.scope.db
    .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
    WHERE session_id=? AND epoch=? AND turn_marker=1 AND context_clear=0 AND root=1`)
    .get(...context.scope.prefix)
  const settledAt = row?.sequence == null ? -1 : Number(row.sequence)
  const item = context.scope.db.prepare(`SELECT sequence FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND turn_scope_kind='thread'`)
  return pending.some((send) => {
    const placed = item.get(
      ...context.scope.prefix,
      agentJournalSubmissionKey(send.clientMessageId)
    )
    return placed !== undefined && Number(placed.sequence) > settledAt
  })
}
