import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
// Settle ended generations atomically at the current fence. Death/replacement proof interrupts;
// absent proof marks unverifiable, revisable by later proof. Failed settlement holds no live work.

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

/** Missing replacedRuntime means no replaced runtime. */
export type StructuredAgentSessionLeftoverStore = Pick<AgentSessionRecordStore, 'getRecord'> &
  Partial<Pick<AgentSessionRecordStore, 'replacedRuntime'>>

export type StructuredAgentSessionExitSettlement = Omit<
  StructuredAgentSessionDeadGenerationInput,
  'journal' | 'sessionId' | 'fence'
> & { ownerFence: number }

export type StructuredAgentSessionLeftoverSettlementInput = {
  store: StructuredAgentSessionLeftoverStore
  sessionId: string
  journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal
  exit?: StructuredAgentSessionExitSettlement
  /** Observed root exit ends the generation even if lease release failed. */
  ended?: StructuredAgentSessionWorkEvidence['ended']
  finalizingOwner?: () => void
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
    const liveFence = structuredAgentSessionLiveFence({
      record,
      replaced,
      ...(input.ended ? { ended: input.ended } : {})
    })
    // New live generations invalidate exit-specific settlement; use general leftover rules instead.
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
          // Read current lease proof with the rows; observed exits supply proof before release.
          deathEvidence: input.store.getRecord(sessionId)?.lease.deathEvidence ?? null,
          replaced,
          failureTextContext,
          below
        })
        const mutations = [...exited.mutations, ...stale.mutations]
        const dispatches = [
          ...exited.dispatches,
          ...stale.dispatches.filter((entry) => !settledByExit.has(entry.clientMessageId))
        ].filter(
          (entry) =>
            !continuingStructuredAgentSessionInput(journal, entry.clientMessageId) &&
            // Exit proof can settle a send now; generic doubt waits for its own result.
            (entry.state === 'rejected' ||
              !finalizingStructuredAgentSessionInput(
                journal,
                entry.clientMessageId,
                input.finalizingOwner
              ))
        )
        planned = mutations.length + dispatches.length
        return { mutations, dispatches }
      }
    })
    return { ok: true, planned }
  } catch (error) {
    return { ok: false, error }
  }
}
