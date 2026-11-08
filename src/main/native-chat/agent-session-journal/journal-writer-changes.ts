import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalEntryChange } from './projection/journal-transition-collections'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalWriterEffectResult } from './journal-writer-effects'
import type { JournalGoalAttachmentSnapshot } from './writing/journal-goal-attachment-inverse'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import type { JournalReducerState } from './projection/journal-reducer'
import type {
  AgentJournalRenderItem,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'

export type JournalWriterPublication = {
  items: AgentJournalRenderItem[]
  cards: QueuedMessageRow[]
  receipts: AgentJournalAcceptanceReceipt[]
  removedItemIds?: string[]
  invalidatedItemIds?: string[]
  placements?: { messageId: string; position: number }[]
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
  referencedUploads?: string[]
}

export type JournalWriterCommit = {
  publication?: JournalWriterPublication
  cursor: AgentJournalCursor
  inputChanged: boolean
  keys: { collection: string; key: unknown; deleted: boolean }[]
  items: (
    | { itemId: string; deleted: true; revision: number }
    | { itemId: string; deleted: false; revision: number; sequence: number; sequenceIndex: number }
  )[]
  /** First presence before this command changed a submission key; captures ignore older cursors. */
  inputKeys: [string, boolean][]
  effects: JournalWriterEffectResult[]
  /** The command's receipt was written in its transaction; absent when it rolled back or wrote none. */
  receiptWritten?: true
  /** The operation's own serializable answer (a cursor, card, update or move result). */
  value?: unknown
  /** The host adopts this copy of its goal attachment proofs after COMMIT. */
  goals?: JournalGoalAttachmentSnapshot
  /** The host adopts its staged stopped-cut withdrawal only when the writer applied it. */
  withdrewCut?: UsageLimitContinueIdentity
}

/** Only identities leave the writer; history bodies are resolved by the reader's capability. */
export class JournalWriterChanges {
  private readonly keys = new Map<string, JournalWriterCommit['keys'][number]>()
  private readonly itemIds = new Set<string>()

  record(changes: readonly JournalEntryChange[]): void {
    for (const { path: collection, key, deleted } of changes) {
      this.keys.set(JSON.stringify([collection, key]), { collection, key, deleted })
      if ((collection === 'items' || collection === 'tombstones') && typeof key === 'string') {
        this.itemIds.add(key)
      }
    }
  }

  finish(
    scope: JournalSqlScope,
    state: JournalReducerState
  ): Pick<JournalWriterCommit, 'keys' | 'items'> {
    const items: JournalWriterCommit['items'] = []
    for (const itemId of this.itemIds) {
      const row = scope.db
        .prepare(`SELECT revision, sequence, sequence_index FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND entry_key=?`)
        .get(...scope.prefix, JSON.stringify(itemId))
      if (row) {
        scope.examined(row)
        items.push({
          itemId,
          deleted: false,
          revision: Number(row.revision),
          sequence: Number(row.sequence),
          sequenceIndex: Number(row.sequence_index)
        })
      } else {
        items.push({ itemId, deleted: true, revision: state.tombstones.get(itemId) ?? 0 })
      }
    }
    return { keys: [...this.keys.values()], items }
  }
}
