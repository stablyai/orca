import type Database from '../../sqlite/sync-database'
import { journalRowsAfterReader } from './journal-open'
import { createHash } from 'node:crypto'
import type { AgentJournalAcceptanceReceipt } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-identity'
import type { JournalReducerState } from './journal-reducer'
import type { JournalReadRow, JournalRowsRead } from './journal-read-row'
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

export function projectJournalRows<Row extends JournalReadRow>(
  state: JournalReducerState,
  rows: readonly Row[]
): Row[] {
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
  rowsAfter: (sequence: number) => JournalRowsRead,
  cursor: AgentJournalCursor
) {
  return readJournalSince(
    {
      state: {
        epoch: journalContextCursor(state).epoch,
        lastSequence: state.lastSequence,
        oldestSequence: state.oldestSequence
      },
      rowsAfter: (sequence) => {
        const read = rowsAfter(sequence)
        return { ...read, rows: projectJournalRows(state, read.rows) }
      }
    },
    cursor,
    () => journalContextCursor(state)
  )
}

export function readStoredJournalContextSince(
  db: Database.Database,
  state: JournalReducerState,
  cursor: AgentJournalCursor,
  limit?: number
) {
  return readJournalContextSince(
    state,
    journalRowsAfterReader(db, state.sessionId, state.epoch, limit),
    cursor
  )
}

export function physicalJournalCursor(
  state: Pick<JournalReducerState, 'epoch' | 'lastSequence'>
): AgentJournalCursor {
  return { epoch: state.epoch, sequence: state.lastSequence }
}
