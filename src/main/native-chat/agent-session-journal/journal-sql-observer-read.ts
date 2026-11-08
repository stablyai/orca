import { latestStructuredAgentSessionTurn } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import {
  StructuredAgentSessionWorkPolicy,
  structuredAgentSessionLiveFence,
  structuredAgentSessionOwnerUnverifiable,
  withStructuredAgentSessionDiedTurnVerdict
} from '../agent-session-wire/observations/structured-agent-session-work-policy'
import { journalWroteBeforeOpen } from './replay/journal-cursor'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type {
  JournalObserverRead,
  JournalObserverResult,
  JournalWorkAuthority
} from './journal-observer-read'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'

export function readJournalSqlCurrentWork(
  context: JournalSqlStatusContext,
  authority: JournalWorkAuthority
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

/** Status, cuts and current work share one ready snapshot and one captured live authority. */
export function readJournalSqlObserver(
  context: JournalSqlStatusContext,
  input: JournalObserverRead
): JournalObserverResult {
  const { authority } = input
  const work = readJournalSqlCurrentWork(context, authority)
  const boundary = context.select({ kind: 'boundary' })[Symbol.iterator]().next().value?.item
  const actionablePrompts = [...context.select({ kind: 'pending-prompts' })].flatMap(({ item }) => {
    const displayed = work.isCurrentItem(item.itemId) ? context.displayed(item.itemId) : null
    return displayed ? [displayed] : []
  })
  return {
    cursor: { epoch: context.epoch, sequence: context.sequence },
    physicalCursor: { epoch: context.scope.epoch, sequence: context.sequence },
    lastActivityAt: context.lastActivityAt,
    authority,
    state: withStructuredAgentSessionDiedTurnVerdict(
      readJournalSqlStatusState(context, authority.record?.currentFence, work.scope),
      work.diedTurn()
    ),
    indicators: readJournalSqlStatusIndicators(
      context,
      {
        start: input.start,
        floor: input.floor ?? context.contextFloor(),
        stop: authority.stop
      },
      work.scope,
      input.firstInputSubmissionKey
    ),
    usageLimitCut: readJournalSqlUsageLimitCut(context),
    orcaStopCut: readJournalSqlOrcaStopCut(context),
    work: {
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
}
