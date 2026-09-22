import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalRow } from './journal-row-schema'

/** One render item, built the same way by every upsert path in the reducer.
 *  The row-level markers are copied here rather than at each call site: they
 *  were three separate spreads that had to stay in sync, and absence is the
 *  claim in each case — appended live, and produced by the session's own agent. */
export function journalRenderItem(
  itemId: string,
  revision: number,
  body: AgentJournalItemBody,
  row: JournalRow
): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    body,
    sequence: row.seq,
    observedAt: row.ts,
    ...(row.recovered ? { recovered: row.recovered } : {}),
    ...agentJournalLinkageFields(row)
  }
}
