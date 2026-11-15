import { readJournalSqlCurrentWork, readJournalSqlWorkState } from './journal-sql-work-read'
import { withStructuredAgentSessionDiedTurnVerdict } from '../agent-session-wire/observations/structured-agent-session-work-policy'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'

/** Status, cuts and current work share one ready snapshot and one captured live authority. */
export function readJournalSqlObserver(
  context: JournalSqlStatusContext,
  input: JournalObserverRead
): JournalObserverResult {
  const { authority } = input
  const work = readJournalSqlCurrentWork(context, authority)
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
    work: readJournalSqlWorkState(context, work)
  }
}
