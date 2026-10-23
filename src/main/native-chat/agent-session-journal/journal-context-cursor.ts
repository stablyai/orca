import { createHash } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor
} from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { readJournalSince } from './journal-cursor'

/** Public context identity changes without changing the physical journal's ownership/order. */
export function journalContextEpoch(epoch: string, boundary: number): string {
  return boundary > 1
    ? `context-v1:${createHash('sha256')
        .update(JSON.stringify([epoch, boundary]))
        .digest('hex')}`
    : epoch
}

export function journalContextCursor(
  state: Pick<JournalReducerState, 'epoch' | 'contextBoundary' | 'lastSequence'>,
  sequence = state.lastSequence
): AgentJournalCursor {
  return { epoch: journalContextEpoch(state.epoch, state.contextBoundary), sequence }
}

export function projectJournalRows(
  state: JournalReducerState,
  rows: readonly JournalRow[]
): JournalRow[] {
  const boundary = Math.max(
    state.contextBoundary,
    rows.findLast((row) => row.kind === 'epoch')?.seq ?? 1
  )
  const epoch = journalContextEpoch(state.epoch, boundary)
  return rows.map((row) => ({ ...row, epoch }))
}

export function journalContextReceipt(
  state: JournalReducerState,
  clientMessageId: string
): AgentJournalAcceptanceReceipt | null {
  const receipt = state.receipts.get(clientMessageId)
  return receipt
    ? { ...receipt, cursor: journalContextCursor(state, receipt.cursor.sequence) }
    : null
}

export function readJournalContextSince(
  state: JournalReducerState,
  rowsAfter: (sequence: number) => JournalRow[],
  cursor: AgentJournalCursor
) {
  return readJournalSince(
    {
      state: {
        epoch: journalContextCursor(state).epoch,
        lastSequence: state.lastSequence,
        oldestSequence: state.oldestSequence
      },
      rowsAfter: (sequence) => projectJournalRows(state, rowsAfter(sequence))
    },
    cursor,
    () => journalContextCursor(state)
  )
}
