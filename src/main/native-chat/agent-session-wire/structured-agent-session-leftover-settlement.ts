// The one settlement of what ended generations left unfinished. An observed exit runs it, with
// what it saw.
//
// Re-derived each time from the journal, the lease and this host's sight of an exit: every turn,
// call, prompt, reasoning row, subagent roster entry and background task whose execution belongs
// to a generation that is not live (`structuredAgentSessionLiveFence`), and every send handed to
// one and never answered. Its turns end `interrupted` only when death evidence names that
// generation or a runtime this one replaced held it, else `unverifiable`, and a later proof revises
// an earlier `unverifiable`. Rows land at the lease's current fence in ONE transaction; a run with
// nothing left plans no row and writes nothing. A failure leaves rows that hold nothing, since the
// projection counts only the live generation's work; the open or the next start settles them.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  planStructuredAgentSessionDeadGeneration,
  type StructuredAgentSessionDeadGenerationInput
} from './structured-agent-session-dead-generation-settlement'
import {
  planStaleStructuredAgentSessionState,
  type StaleStructuredAgentSessionStateJournal
} from './structured-agent-session-stale-state-settlement'
import type { DeadGenerationJournal } from './structured-agent-session-unfinished-work'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import {
  structuredAgentSessionLiveFence,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'

/** Without `replacedRuntime`, a store whose runtime replaced none. */
export type StructuredAgentSessionLeftoverStore = Pick<AgentSessionRecordStore, 'getRecord'> &
  Partial<Pick<AgentSessionRecordStore, 'replacedRuntime'>>

/** An observed exit's settlement: what that child's generation left, settled as the exit says. */
export type StructuredAgentSessionExitSettlement = Omit<
  StructuredAgentSessionDeadGenerationInput,
  'journal' | 'sessionId' | 'fence'
> & { ownerFence: number }

export type StructuredAgentSessionLeftoverSettlementInput = {
  store: StructuredAgentSessionLeftoverStore
  sessionId: string
  journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal
  exit?: StructuredAgentSessionExitSettlement
  /** This host's sight of a child's root exit, which ends its generation even when the release
   *  write failed (`StructuredAgentSessionHostSession.lastEndedChild`). */
  ended?: StructuredAgentSessionWorkEvidence['ended']
}

export type StructuredAgentSessionLeftoverSettlement =
  | { ok: true; planned: number }
  | { ok: false; error: unknown }

export async function settleStructuredAgentSessionLeftovers(
  input: StructuredAgentSessionLeftoverSettlementInput
): Promise<StructuredAgentSessionLeftoverSettlement> {
  try {
    const record = input.store.getRecord(input.sessionId)
    if (!record) {
      return { ok: true, planned: 0 }
    }
    const fence = record.lease.runtimeFence
    const { journal, sessionId } = input
    const replaced = input.store.replacedRuntime?.(sessionId)
    // Everything below the live generation is ended; with none live, all of it is.
    const liveFence = structuredAgentSessionLiveFence({
      record,
      replaced,
      ...(input.ended ? { ended: input.ended } : {})
    })
    // An exit's own account holds only until a later generation is live: its rows and sends at
    // this fence would be that generation's. The general rule settles what the exit left instead.
    const exit = liveFence === null ? input.exit : undefined
    const below = exit ? exit.ownerFence : (liveFence ?? fence + 1)
    const failureTextContext = structuredAgentSessionFailureWordsContext(record)
    let planned = 0
    await journal.appendPlannedLifecycleBatch({
      settlementId: exit
        ? `dead-generation:${exit.settlementId}`
        : `${STALE_SESSION_ROW_PREFIX}${sessionId}:${fence}:seq-${journal.cursor().sequence}`,
      fence,
      recovered: true,
      plan: () => {
        const exited = exit
          ? planStructuredAgentSessionDeadGeneration(
              { ...exit, journal, sessionId, fence },
              (itemFence) => itemFence === undefined || itemFence >= exit.ownerFence
            )
          : { mutations: [], dispatches: [] }
        const settledByExit = new Set(exited.dispatches.map((entry) => entry.clientMessageId))
        const stale = planStaleStructuredAgentSessionState({
          journal,
          sessionId,
          fence,
          acquisitionGeneration: null,
          // Read with the rows: the proof the lease holds now. On an observed exit this settlement
          // runs before the release, so the exit's own account (`exit`) judges instead.
          deathEvidence: input.store.getRecord(sessionId)?.lease.deathEvidence ?? null,
          replaced,
          failureTextContext,
          below
        })
        const mutations = [...exited.mutations, ...stale.mutations]
        const dispatches = [
          ...exited.dispatches,
          ...stale.dispatches.filter((entry) => !settledByExit.has(entry.clientMessageId))
        ]
        planned = mutations.length + dispatches.length
        return { mutations, dispatches }
      }
    })
    return { ok: true, planned }
  } catch (error) {
    return { ok: false, error }
  }
}
