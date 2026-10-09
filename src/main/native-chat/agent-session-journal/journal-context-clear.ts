import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session-provider-context'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalTombstoneRow } from './journal-row-schema'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'

export function appendJournalContextClear(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  boundary: AgentSessionProviderContextBoundary
  receipt: JournalOperationReceipt
  settledByOp: string
  /** A /clear card the queue runs: spent here, and only the cards queued before it were written
   *  for the context it discards. Those behind it were sent for the fresh one and stay as they are. */
  ranFrom?: string
}) {
  const { boundary, state, ranFrom } = input
  let commandIds: string[] = []
  return input.writer
    .enqueueRows(
      () => {
        const all = input.cards.list()
        const at =
          ranFrom === undefined ? all.length : all.findIndex((c) => c.messageId === ranFrom)
        if (at < 0) {
          throw new QueuedMessageNotConsumableError(ranFrom ?? '', 'waiting')
        }
        const cards = all.slice(0, at)
        commandIds = cards
          .filter(
            (card) => card.body.command && (card.state === 'waiting' || card.state === 'returned')
          )
          .map((card) => card.messageId)
          .concat(ranFrom === undefined ? [] : [ranFrom])
        const messageIds = cards
          .filter((card) => card.state === 'waiting' && !card.body.command)
          .map((card) => card.messageId)
        return [
          journalItemRowBuilder(
            state,
            { provider: 'orca', clientMessageId: `context-clear:${boundary.operationId}` },
            {
              kind: 'status',
              text: 'Context cleared',
              presentation: 'context-cleared',
              contextClear: boundary
            },
            { fence: boundary.afterFence, turnScope: { kind: 'thread' } }
          ),
          (seq: number, ts: number): JournalTombstoneRow =>
            buildJournalQueueClearRow({
              state: state(),
              seq,
              ts,
              fence: boundary.afterFence,
              clear: { operationId: boundary.operationId, messageIds }
            })
        ]
      },
      {
        write: (db) => {
          const withdrawn = input.cards.withdrawInTransaction(db, {
            messageIds: commandIds,
            settledByOp: input.settledByOp
          })
          // The card and its clear commit together or not at all, so it can never run twice.
          if (ranFrom !== undefined && !withdrawn.includes(ranFrom)) {
            throw new QueuedMessageNotConsumableError(ranFrom, 'waiting')
          }
          input.receipt.write(db)
        },
        committed: input.receipt.committed
      }
    )
    .then((rows) => ({
      epoch: state().epoch,
      sequence: rows.at(-1)?.seq ?? state().lastSequence
    }))
}
