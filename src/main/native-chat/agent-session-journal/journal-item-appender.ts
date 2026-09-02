import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'
import type { JournalAppendResult } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import { appendToolOutputFallback } from './journal-tool-output-fallback'

type ItemAppendOptions = { fence: number; observedAt?: number; recovered?: true }
type JournalBlob = { digest: string; payload: string }

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      journal: () => AgentSessionJournal
      state: () => JournalReducerState
      enqueue: (
        build: (seq: number, ts: number) => JournalRow,
        blobs?: readonly JournalBlob[]
      ) => Promise<JournalRow>
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: ItemAppendOptions
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options))
      .then((row) => itemAppendResult(row, itemId))
  }

  appendWithBlobs(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs: readonly JournalBlob[],
    options: ItemAppendOptions
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    return this.deps
      .enqueue(journalItemRowBuilder(this.deps.state, identity, body, options), blobs)
      .then((row) => itemAppendResult(row, itemId))
      .catch((error: unknown) =>
        appendToolOutputFallback({
          journal: this.deps.journal(),
          error,
          identity,
          body,
          blobs,
          itemId,
          fence: options.fence
        })
      )
  }
}

function itemAppendResult(row: JournalRow, itemId: string): JournalAppendResult {
  return {
    cursor: { epoch: row.epoch, sequence: row.seq },
    itemId,
    revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
  }
}
