import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalLinkageFields,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
import type { JournalRow } from './journal-row-schema'

/** Centralize row markers: absence means live append/session producer, not missing propagation. */
export function journalRenderItem(
  itemId: string,
  revision: number,
  body: AgentJournalItemBody,
  row: JournalRow,
  turnScope: AgentJournalTurnScope,
  producer: AgentJournalProducerLinkage = row,
  sequenceIndex = 0
): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    body,
    sequence: row.seq,
    ...(sequenceIndex > 0 ? { sequenceIndex } : {}),
    observedAt: row.ts,
    ...(row.recovered ? { recoveredAt: row.ts } : {}),
    ...(row.recovered ? { recovered: row.recovered } : {}),
    turnScope,
    ...agentJournalLinkageFields(producer)
  }
}

/** Prefer per-mutation producers; retain legacy whole-batch linkage as fallback. */
export function journalBatchMutationProducer(
  row: AgentJournalProducerLinkage,
  mutation: AgentJournalProducerLinkage
): AgentJournalProducerLinkage {
  return namesAgentJournalProducer(mutation) ? mutation : row
}
