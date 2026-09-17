import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { journalDispatchRowBuilder, journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalAppendResult, ResolveDispatchInput } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

type ItemAppendOptions = {
  fence: number
  observedAt?: number
  recovered?: true
}

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      enqueueMany: (
        build: (seq: number, ts: number) => readonly JournalRow[]
      ) => Promise<JournalRow[]>
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: ItemAppendOptions,
    ownerEndedDispatches: () => ResolveDispatchInput[]
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    const build = journalItemRowBuilder(this.deps.state, identity, body, options)
    return this.deps
      .enqueueMany((seq, ts) => {
        const item = build(seq, ts)
        const dispatches = ownerEndedDispatches()
        return [
          item,
          ...dispatches.map((input, index) =>
            journalDispatchRowBuilder(this.deps.state, input)(seq + index + 1, ts)
          )
        ]
      })
      .then((rows) => {
        const row = rows[0]
        if (!row || row.kind !== 'item') {
          throw new Error('journal_item_append_returned_non_item_row')
        }
        return {
          cursor: { epoch: row.epoch, sequence: row.seq },
          itemId,
          revision: row.revision
        }
      })
  }
}
