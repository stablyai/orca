import { latestStructuredAgentSessionTurn } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import {
  StructuredAgentSessionWorkPolicy,
  structuredAgentSessionLiveFence,
  structuredAgentSessionOwnerUnverifiable
} from '../agent-session-wire/observations/structured-agent-session-work-policy'
import { journalWroteBeforeOpen } from './replay/journal-cursor'
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

export function readJournalSqlCurrentWork(
  context: JournalSqlStatusContext,
  authority: JournalCurrentWorkAuthority
) {
  const handingOver = new Set(authority.handingOver)
  const continuing = new Set(authority.continuingUnadmitted)
  const finalizing = new Set(authority.finalizing)
  const held =
    authority.child?.heldSends === undefined ? undefined : new Set(authority.child.heldSends)
  const evidence = {
    record: authority.record,
    ended: authority.ended,
    replaced: authority.replaced,
    child:
      authority.child === null
        ? null
        : authority.child === undefined
          ? undefined
          : { fence: authority.child.fence }
  }
  return new StructuredAgentSessionWorkPolicy(
    {
      item: context.displayed,
      itemFence: context.itemFence,
      runningTurn: context.runningTurn,
      recoverableSubmissions: context.recoverableSubmissions,
      wroteBeforeOpen: (sequence) =>
        journalWroteBeforeOpen({ epoch: context.scope.epoch }, authority.openedThrough, sequence),
      continuingInput: (id) =>
        continuing.has(id) && context.submission(id)?.dispatchState === 'pending',
      finalizingInput: (id) => finalizing.has(id),
      handingOver: (id) => handingOver.has(id)
    },
    structuredAgentSessionLiveFence(evidence),
    authority.operationalRevision,
    authority.ended,
    authority.replaced,
    structuredAgentSessionOwnerUnverifiable(evidence),
    () => held
  )
}

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
  return {
    liveFence: work.liveFence,
    allowsObservation: work.allowsObservation(),
    working: work.working(),
    owesAnySend: work.owesAnySend(),
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

export function readJournalSqlWork(
  context: JournalSqlStatusContext,
  input: JournalSqlWorkRead
): JournalSqlWorkResult {
  const work = readJournalSqlCurrentWork(context, input.authority)
  return {
    cursor: { epoch: context.epoch, sequence: context.sequence },
    physicalCursor: { epoch: context.scope.epoch, sequence: context.sequence },
    authority: input.authority,
    result: readWork(context, work, input.operation)
  }
}

function readWork(
  context: JournalSqlStatusContext,
  work: StructuredAgentSessionWorkPolicy,
  operation: JournalWorkRead
): JournalWorkReadResult {
  switch (operation.kind) {
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
