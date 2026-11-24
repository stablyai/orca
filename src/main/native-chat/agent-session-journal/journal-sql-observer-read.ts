import { readJournalSqlCurrentWork, readJournalSqlWorkState } from './journal-sql-work-read'
import { withStructuredAgentSessionDiedTurnVerdict } from '../agent-session-wire/observations/structured-agent-session-work-policy'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'
import { readJournalSqlGoalRows } from './projection/journal-thread-goal-source'
import { agentSessionThreadGoalStartsTurns } from '../../../shared/agent-session/thread-goals/agent-session-thread-goal'

/** Status, cuts and current work share one ready snapshot and one captured live authority. */
export function readJournalSqlObserver(
  context: JournalSqlStatusContext,
  input: JournalObserverRead
): JournalObserverResult {
  const { authority } = input
  const work = readJournalSqlCurrentWork(context, authority)
  const state = withStructuredAgentSessionDiedTurnVerdict(
    readJournalSqlStatusState(
      context,
      authority.record?.currentFence,
      work.scope,
      input.botSession === true
    ),
    work.diedTurn()
  )
  // A dead generation starts no next turn, so its active goal cannot hold completion.
  const goalContinues =
    work.liveFence !== null &&
    agentSessionThreadGoalStartsTurns(
      readJournalSqlGoalRows(context.scope.db, context.scope.prefix)[0]
    )
  return {
    cursor: { epoch: context.epoch, sequence: context.sequence },
    physicalCursor: { epoch: context.scope.epoch, sequence: context.sequence },
    lastActivityAt: context.lastActivityAt,
    authority,
    state: goalContinues ? { ...state, goalContinues } : state,
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
    work: readJournalSqlWorkState(context, work, input.authority)
  }
}
