import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentJournalRenderItem,
  AgentJournalTurnScope,
  AgentJournalTurn
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalLinkageFields,
  namesAgentJournalProducer
} from '../../../shared/agent-session-journal-producer'
import type { JournalRow } from './journal-row-schema'

/** One render item, built the same way by every upsert path in the reducer.
 *  The row-level markers are copied here rather than at each call site: they
 *  were three separate spreads that had to stay in sync, and absence is the
 *  claim in each case — appended live, and (on a row's first write) produced by
 *  the session's own agent. */
export function journalRenderItem(
  itemId: string,
  revision: number,
  body: AgentJournalItemBody,
  row: JournalRow,
  turnScope: AgentJournalTurnScope,
  producer: AgentJournalProducerLinkage = row,
  /** Which of the row's writes this is; only a lifecycle batch has more than one. */
  sequenceIndex = 0,
  turn: AgentJournalTurn | undefined = 'turn' in row ? row.turn : undefined
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
    ...agentJournalLinkageFields(producer),
    ...(turn ? { turn } : {})
  }
}

/** Who one mutation of a batch names as its producer: the mutation itself when
 *  it names one, else the batch row, which only a host stamping whole batches
 *  wrote. Naming none leaves the reducer to keep the row's existing producer. */
export function journalBatchMutationProducer(
  row: AgentJournalProducerLinkage,
  mutation: AgentJournalProducerLinkage
): AgentJournalProducerLinkage {
  return namesAgentJournalProducer(mutation) ? mutation : row
}
