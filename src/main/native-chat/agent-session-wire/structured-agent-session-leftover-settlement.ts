// The one settlement of what ended generations left unfinished. An observed exit runs it first,
// with what it saw; the host's retry runs it after every generation end and at startup
// (`structured-agent-session-reconciliation-retry.ts`). Opening a chat never runs it. Bookkeeping
// no person waits on, so it writes only through a background handle (`BackgroundSettlementWrites`).
//
// Re-derived each time from the journal, the lease and this host's sight of an exit: every turn,
// call, prompt, reasoning row, subagent roster entry and background task whose execution belongs
// to a generation that is not live (`structuredAgentSessionLiveFence`), and every send handed to
// one and never answered. Its turns end `interrupted` only when death evidence names that
// generation, else `unverifiable`, and a later proof revises an earlier `unverifiable`. Rows land at
// the lease's current fence in ONE transaction; a run with nothing left plans no row and writes
// nothing. A failure is the caller's to retry: its rows hold nothing, since the projection counts
// only the live generation's work.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  planStructuredAgentSessionDeadGeneration,
  type StructuredAgentSessionDeadGenerationInput
} from './structured-agent-session-dead-generation-settlement'
import {
  planStaleStructuredAgentSessionState,
  type StaleStructuredAgentSessionStateJournal
} from './structured-agent-session-stale-state-settlement'
import type { DeadGenerationJournal } from './structured-agent-session-unfinished-work'
import type { BackgroundSettlementWrites } from './structured-agent-session-background-writes'
import { STALE_SESSION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import {
  structuredAgentSessionLiveFence,
  type StructuredAgentSessionWorkEvidence
} from './structured-agent-session-current-work'

export type StructuredAgentSessionLeftoverStore = Pick<AgentSessionRecordStore, 'getRecord'>

/** An observed exit's settlement: what that child's generation left, settled as the exit says. */
export type StructuredAgentSessionExitSettlement = Omit<
  StructuredAgentSessionDeadGenerationInput,
  'journal' | 'sessionId' | 'fence'
> & { ownerFence: number }

export type StructuredAgentSessionLeftoverSettlementInput = {
  store: StructuredAgentSessionLeftoverStore
  sessionId: string
  /** Read for the plan; the settlement's write goes through `writes`. */
  journal: DeadGenerationJournal & StaleStructuredAgentSessionStateJournal
  writes: BackgroundSettlementWrites
  exit?: StructuredAgentSessionExitSettlement
  /** This host's sight of a child's root exit, which ends its generation even when the release
   *  write failed (`StructuredAgentSessionHostSession.lastEndedChild`). */
  ended?: StructuredAgentSessionWorkEvidence['ended']
  /** Proof a generation end carried that the lease no longer holds (a reservation that replaced a
   *  proven-dead owner clears it, and a later release writes its own): only what that generation
   *  and earlier ones left is settled, judged by it. Absent: the lease's own evidence judges. */
  proof?: AgentSessionDeathEvidence & { ownerFence: number }
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
    // Everything below the live generation is ended; with none live, all of it is.
    const liveFence = structuredAgentSessionLiveFence({
      record,
      ...(input.ended ? { ended: input.ended } : {})
    })
    // An exit's own account holds only until a later generation is live: its rows and sends at
    // this fence would be that generation's. The general rule settles what the exit left instead.
    const exit = liveFence === null && !input.proof ? input.exit : undefined
    const { proof } = input
    const below = proof
      ? Math.min(proof.ownerFence + 1, liveFence ?? fence + 1)
      : exit
        ? exit.ownerFence
        : (liveFence ?? fence + 1)
    const failureTextContext = structuredAgentSessionFailureWordsContext(record)
    let planned = 0
    await input.writes.appendPlannedLifecycleBatch({
      settlementId: exit
        ? `dead-generation:${exit.settlementId}`
        : `${STALE_SESSION_ROW_PREFIX}${sessionId}:${fence}:${proof ? `proof-${proof.ownerFence}:` : ''}seq-${journal.cursor().sequence}`,
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
          deathEvidence: proof ?? input.store.getRecord(sessionId)?.lease.deathEvidence ?? null,
          failureTextContext,
          below,
          // With an exit's account, nothing is live: every entry of what is settled is ended.
          ...(exit ? {} : { entriesBelow: below })
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
