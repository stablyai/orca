import type {
  JournalStaleSettlementInput,
  JournalDeadGenerationSettlementInput,
  JournalUnheldTurnsSettlementInput
} from '../journal-store-contracts'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalItemExecutionFence } from '../projection/journal-item-provenance'
import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import { runningTurnLifecycleRevisions } from '../../agent-session-wire/termination/structured-agent-session-stale-turn-verdict'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { STALE_SESSION_ROW_PREFIX } from '../../../../shared/agent-session/lifecycle/agent-session-stop-row-identity'
import {
  planStaleStructuredAgentSessionState,
  type StaleStructuredAgentSessionStateJournal
} from '../../agent-session-wire/termination/structured-agent-session-stale-state-settlement'
import { planStructuredAgentSessionDeadGeneration } from '../../agent-session-wire/termination/structured-agent-session-dead-generation-settlement'
import type { DeadGenerationJournal } from '../../agent-session-wire/termination/structured-agent-session-unfinished-work'

type SettlementJournal = StaleStructuredAgentSessionStateJournal & DeadGenerationJournal

export async function settleJournalStaleState(
  journal: StaleStructuredAgentSessionStateJournal,
  lifecycle: Pick<JournalLifecycleBatchAppender, 'appendPlanned'>,
  input: JournalStaleSettlementInput
): Promise<number> {
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  let planned = 0
  await lifecycle.appendPlanned({
    settlementId: `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`,
    fence: input.fence,
    recovered: true,
    plan: () => {
      const plan = planStaleStructuredAgentSessionState({ ...input, journal })
      planned = plan.mutations.length
      return plan
    }
  })
  return planned
}

/** Only volatile ownership crosses the port; saved pending state is checked at the write. */
export async function settleJournalDeadGeneration(
  journal: SettlementJournal,
  lifecycle: Pick<JournalLifecycleBatchAppender, 'appendPlanned'>,
  input: JournalDeadGenerationSettlementInput
): Promise<number> {
  const { exit, sessionId, fence } = input
  let planned = 0
  await lifecycle.appendPlanned({
    settlementId: exit
      ? `dead-generation:${exit.settlementId}`
      : `${STALE_SESSION_ROW_PREFIX}${sessionId}:${fence}:seq-${journal.cursor().sequence}`,
    fence,
    recovered: true,
    keepFailedStart: exit?.exitedDuringStartup !== undefined,
    plan: () => {
      const exited = exit
        ? planStructuredAgentSessionDeadGeneration(
            { ...exit, journal, sessionId, fence },
            (owner) => owner === undefined || owner >= exit.ownerFence,
            input
          )
        : { mutations: [], dispatches: [] }
      const settledByExit = new Set(exited.dispatches.map((entry) => entry.clientMessageId))
      const stale = planStaleStructuredAgentSessionState({
        ...input,
        journal,
        acquisitionGeneration: null
      })
      const continuing = new Set(input.continuingInputs)
      const finalizing = new Set(
        input.finalizingInputs
          .filter((entry) => !entry.settlementOwner)
          .map((entry) => entry.clientMessageId)
      )
      const pending = new Set(
        journal.inputOrder
          .recoverableSubmissions()
          .filter((send) => send.dispatchState === 'pending')
          .map((send) => send.clientMessageId)
      )
      const mutations = [...exited.mutations, ...stale.mutations]
      const dispatches = [
        ...exited.dispatches,
        ...stale.dispatches.filter((entry) => !settledByExit.has(entry.clientMessageId))
      ].filter(
        (entry) =>
          !(continuing.has(entry.clientMessageId) && pending.has(entry.clientMessageId)) &&
          (entry.state === 'rejected' || !finalizing.has(entry.clientMessageId))
      )
      planned = mutations.length + dispatches.length
      return { mutations, dispatches }
    }
  })
  return planned
}

/** The child is not running these turns; the running population is read at the write position. */
export async function settleJournalUnheldTurns(
  state: () => JournalReducerState,
  lifecycle: Pick<JournalLifecycleBatchAppender, 'appendPlanned'>,
  input: JournalUnheldTurnsSettlementInput
): Promise<void> {
  const { sessionId, fence, generation, liveTurnId } = input
  await lifecycle.appendPlanned({
    settlementId: `unheld-turns:${sessionId}:${fence}:${generation}`,
    fence,
    recovered: true,
    plan: () => {
      const current = state()
      const unheld = [...current.queries.unsettledItems(current, null)].filter(
        (item) =>
          item.body.kind === 'turn' &&
          item.body.state === 'running' &&
          item.body.turnId !== liveTurnId &&
          isRootAgentJournalItem(item) &&
          journalItemExecutionFence(current, item.itemId) === fence
      )
      return {
        mutations: runningTurnLifecycleRevisions(unheld, { state: 'interrupted' }),
        dispatches: []
      }
    }
  })
}
