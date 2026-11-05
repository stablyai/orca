import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { HistoryItemForm } from './agent-session-history-page-bounds'
export type HistoryReader = {
  form: (item: AgentJournalRenderItem) => HistoryItemForm
  budgetBytes: number
  /** Forward reads project touched identities; cold reads include retained sources before bounds. */
  snapshot?: (
    journal: AgentSessionJournal,
    snapshot?: AgentJournalSnapshot,
    touched?: ReadonlySet<string>
  ) => AgentJournalSnapshot
  snapshotSteps?: (
    journal: AgentSessionJournal,
    snapshot: AgentJournalSnapshot,
    touched?: ReadonlySet<string>
  ) => Generator<void, AgentJournalSnapshot>
  queueSourceIds?: (journal: AgentSessionJournal, messageId: string) => readonly string[]
}
