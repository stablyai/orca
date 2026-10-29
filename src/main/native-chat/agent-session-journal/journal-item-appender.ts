import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalAppendResult, JournalItemAppendOptions } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalAttachmentClaim, journalInputClaimsReceipt } from './journal-submission-hook'

// Module-level Error stacks retain startup code and buffers; construct them only when needed.
class NothingResolvedError extends Error {}

export type JournalResolvedItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      inputReceipt: (
        rows: readonly JournalRow[],
        receipt?: JournalOperationReceipt
      ) => ReturnType<typeof journalInputClaimsReceipt>
      state: () => JournalReducerState
      enqueue: JournalRowWriter['enqueue']
      claimAttachments: JournalAttachmentClaim
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions,
    receipt?: JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options), (rows) =>
        this.deps.inputReceipt(rows, receipt)
      )
      .then((row) => appendResult(row, itemId))
  }

  /** A client-authored message claims the uploads it names with its row; a swept one refuses both. */
  appendClaimingAttachments(
    identity: AgentJournalItemIdentity,
    body: AgentJournalMessageItem,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult> {
    let committed: (() => void) | void
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options), {
        write: (db) => {
          committed = this.deps.claimAttachments(
            db,
            body,
            true,
            undefined,
            body.sentAs === 'goal' ? agentJournalItemKey(identity) : undefined
          )
        },
        committed: () => committed?.()
      })
      .then((row) => appendResult(row, agentJournalItemKey(identity)))
  }

  /** Resolve against preceding queued writes; null appends nothing. */
  appendResolved(
    resolve: () => JournalResolvedItem | null,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult | null> {
    let itemId = ''
    return this.deps
      .enqueue(
        (seq, ts) => {
          const resolved = resolve()
          if (resolved === null) {
            throw new NothingResolvedError('journal_item_resolved_to_nothing')
          }
          itemId = agentJournalItemKey(resolved.identity)
          return journalItemRowBuilder(
            this.deps.state,
            resolved.identity,
            resolved.body,
            options
          )(seq, ts)
        },
        (rows) => this.deps.inputReceipt(rows)
      )
      .then(
        (row) => appendResult(row, itemId),
        (error: unknown) => {
          if (error instanceof NothingResolvedError) {
            return null
          }
          throw error
        }
      )
  }
}

function appendResult(row: JournalRow, itemId: string): JournalAppendResult {
  return {
    cursor: { epoch: row.epoch, sequence: row.seq },
    itemId,
    revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
  }
}
