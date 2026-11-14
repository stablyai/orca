import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { structuredAgentSessionHandingOver } from '../delivery/structured-agent-session-handing-over'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionDeadGenerationInput } from './structured-agent-session-dead-generation-settlement'
import { structuredAgentSessionFailureWordsContext } from '../operations/structured-agent-session-send-preparation'
import { structuredAgentSessionLiveFence } from '../observations/structured-agent-session-work-policy'

import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionWorkEvidence } from '../observations/structured-agent-session-work-evidence'
// Settle ended generations atomically at the current fence. Death/replacement proof interrupts;
// absent proof marks unverifiable, revisable by later proof. Failed settlement holds no live work.

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
  journal: AgentSessionJournal
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
      record: agentSessionConversationView(record),
      replaced,
      ...(input.ended ? { ended: input.ended } : {})
    })
    // New live generations invalidate exit-specific settlement; use general leftover rules instead.
    const exit = liveFence === null ? input.exit : undefined
    const below = exit ? exit.ownerFence : (liveFence ?? fence + 1)
    const failureTextContext = structuredAgentSessionFailureWordsContext(record)
    const handovers = [...structuredAgentSessionHandingOver(journal)]
    const planned = await journal.settleDeadGeneration({
      sessionId,
      fence,
      ...(exit ? { exit } : {}),
      below,
      deathEvidence: record.lease.deathEvidence ?? null,
      replaced,
      failureTextContext,
      continuingInputs: handovers.flatMap(([id, entry]) =>
        entry.input?.unadmitted === true && entry.input.signal?.aborted !== true ? [id] : []
      ),
      finalizingInputs: handovers.flatMap(([id, entry]) =>
        entry.input?.finalization
          ? [
              {
                clientMessageId: id,
                ...(entry.input.owner === input.finalizingOwner
                  ? { settlementOwner: true as const }
                  : {})
              }
            ]
          : []
      )
    })
    return { ok: true, planned }
  } catch (error) {
    return { ok: false, error }
  }
}
