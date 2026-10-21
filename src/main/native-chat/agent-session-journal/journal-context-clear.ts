import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session-provider-context'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type { JournalQueuedMessages } from './journal-queued-messages'
import type { JournalTombstoneRow } from './journal-row-schema'
import { buildJournalQueueClearRow } from './journal-stop-and-resume-rows'

export function appendJournalContextClear(input: {
  state: () => JournalReducerState
  writer: JournalRowWriter
  cards: JournalQueuedMessages
  boundary: AgentSessionProviderContextBoundary
  receipt: JournalOperationReceipt
  settledByOp: string
}) {
  const { boundary, state } = input
  let commandIds: string[] = []
  return input.writer
    .enqueueRows(
      () => {
        const cards = input.cards.list()
        commandIds = cards
          .filter(
            (card) => card.body.command && (card.state === 'waiting' || card.state === 'returned')
          )
          .map((card) => card.messageId)
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
          input.cards.withdrawInTransaction(db, {
            messageIds: commandIds,
            settledByOp: input.settledByOp
          })
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
