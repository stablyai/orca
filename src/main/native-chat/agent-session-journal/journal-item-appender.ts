import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalAppendResult, JournalItemAppendOptions } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

const NOTHING_RESOLVED = new Error('journal_item_resolved_to_nothing')

export type JournalResolvedItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options))
      .then((row) => appendResult(row, itemId))
  }

  /** `resolve` reads the fold at the write's own place in the queue; null writes nothing. */
  appendResolved(
    resolve: () => JournalResolvedItem | null,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult | null> {
    let itemId = ''
    return this.deps
      .enqueue((seq, ts) => {
        const resolved = resolve()
        if (resolved === null) {
          throw NOTHING_RESOLVED
        }
        itemId = agentJournalItemKey(resolved.identity)
        return journalItemRowBuilder(
          this.deps.state,
          resolved.identity,
          resolved.body,
          options
        )(seq, ts)
      })
      .then(
        (row) => appendResult(row, itemId),
        (error: unknown) => {
          if (error === NOTHING_RESOLVED) {
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
