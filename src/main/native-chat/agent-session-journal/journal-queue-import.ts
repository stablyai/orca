// Adopt legacy cards and delete their rows atomically, using the same fold before and after import.
// Retry failed bulk import on next open; do not loop while the host is running.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies, queuedHandOffOutcome } from './journal-dispatch-settlement'
import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import { foldQueuedHandOffInDoubt } from './journal-submission-fold'
import {
  QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
  type QueuedMessageRow
} from './queued-message-table'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'

type LegacyDeps = Pick<
  JournalQueuedMessagesDeps,
  'sessionId' | 'database' | 'state' | 'serialize' | 'readOnly' | 'writer' | 'committed'
>

/** Preserve handoff links; copy refusals only when their original rows are no longer in this epoch. */
export function legacyQueuedChange(
  state: JournalReducerState,
  row: QueuedMessageRow
): JournalQueuedChange | null {
  const unconfirmed = row.state === 'waiting' ? unconfirmedHandOff(state, row) : null
  const attempt = row.state === 'waiting' ? (unconfirmed?.attempt ?? null) : row.consumedAs
  if (row.state === 'withdrawn' || (row.state === 'dispatched' && attempt === null)) {
    return null
  }
  const holdReason = unconfirmed?.holdReason ?? (row.state === 'waiting' ? row.holdReason : null)
  const change: JournalQueuedChange = {
    ...queuedChangeOf(row),
    ...(holdReason !== null ? { holdReason } : {}),
    ...(attempt !== null ? { attempt } : {}),
    ...(row.state === 'returned' && (attempt === null || !state.submissions.has(attempt))
      ? {
          returned: {
            reason: row.returnedReason,
            ...(row.returnedRejection ? { rejection: row.returnedRejection } : {})
          }
        }
      : {})
  }
  const card = queuedCardFromChange(state, row.messageId, change)
  return unanswered(card, state.submissions) ? change : null
}

/** Legacy refusals may have cleared handoff links without proving non-delivery.
 * Spend unchanged cards on uncertain attempts; edited/resubmitted cards require explicit Send. */
function unconfirmedHandOff(
  state: JournalReducerState,
  row: QueuedMessageRow
):
  | { attempt: string; holdReason?: undefined }
  | { attempt?: undefined; holdReason: string }
  | null {
  const attempts = [...state.submissions.values()]
    .filter((submission) => submission.queuedMessageId === row.messageId)
    .sort((a, b) => (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0))
  if (!attempts.some(handOffInDoubt)) {
    return null
  }
  const latest = attempts.at(-1)!
  return handOffInDoubt(latest) && latest.payloadFingerprint === row.fingerprint
    ? { attempt: latest.clientMessageId }
    : { holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED }
}

function handOffInDoubt(submission: AgentJournalSubmission): boolean {
  return submission.dispatchState === 'rejected' && queuedHandOffOutcome(submission) === 'inDoubt'
}

function unanswered(
  card: QueuedMessageRow,
  submissions: ReadonlyMap<string, AgentJournalSubmission>
): boolean {
  if (card.state !== 'dispatched') {
    return card.state !== 'withdrawn'
  }
  const handOff = card.consumedAs === null ? undefined : submissions.get(card.consumedAs)
  return handOff === undefined || journalDispatchRowApplies(handOff) || handOffInDoubt(handOff)
}

export class LegacyQueuedCards {
  private revision = 0
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private viewed: { key: string; cards: readonly QueuedMessageRow[] } | null = null

  constructor(private readonly deps: LegacyDeps) {}

  /** Disable fallback when no readable legacy cards remain; classify retained cards through the live fold. */
  key(): string {
    if (this.rows().length === 0) {
      return ''
    }
    const { epoch, lastSequence } = this.deps.state()
    return `${this.revision}:${epoch}:${lastSequence}`
  }

  cards(): readonly QueuedMessageRow[] {
    const key = this.key()
    if (key === '') {
      return []
    }
    if (this.viewed?.key !== key) {
      const state = this.deps.state()
      const cards = this.rows().flatMap((row) => {
        const change = legacyQueuedChange(state, row)
        return change ? [queuedCardFromChange(state, row.messageId, change)] : []
      })
      this.viewed = { key, cards }
    }
    return this.viewed.cards
  }

  // Failed adoption cannot hide spent sends; derive display changes only on copied state.
  displayState(): JournalReducerState {
    const state = this.deps.state()
    const handedOff = this.cards().flatMap((card) => {
      const submission =
        card.consumedAs === null ? undefined : state.submissions.get(card.consumedAs)
      return submission && handOffInDoubt(submission) ? [{ ...submission }] : []
    })
    if (handedOff.length === 0) {
      return state
    }
    const display = {
      ...state,
      items: new Map(state.items),
      submissions: new Map(state.submissions)
    }
    for (const submission of handedOff) {
      display.submissions.set(submission.clientMessageId, submission)
      foldQueuedHandOffInDoubt(display, submission)
    }
    return display
  }

  /** Resolve adoption on the write lane from current disk state; null means no legacy card. */
  adoption(messageId: string): JournalQueuedChange | null {
    if (this.key() === '') {
      return null
    }
    const { db } = this.deps.database()
    const row = db
      .prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`
      )
      .get(this.deps.sessionId, messageId)
    const card = row === undefined ? null : readStoredQueuedMessageRow(row)
    return card && legacyQueuedChange(this.deps.state(), card)
  }

  /** Delete in the caller's transaction and refresh the view after commit. */
  deletion(messageIds: readonly string[]): JournalOperationReceipt {
    return {
      write: (db) => {
        const remove = db.prepare(
          'DELETE FROM queued_messages WHERE session_id = ? AND message_id = ?'
        )
        for (const messageId of messageIds) {
          remove.run(this.deps.sessionId, messageId)
        }
      },
      committed: () => {
        this.revision += messageIds.length > 0 ? 1 : 0
      }
    }
  }

  messageIds(): string[] {
    return this.rows().map((row) => row.messageId)
  }

  deletionOfAll(): JournalOperationReceipt {
    return this.deletion(this.messageIds())
  }

  /** Atomically adopt readable unanswered cards and delete legacy rows; failure leaves both unchanged. */
  importAtOpen(): Promise<void> {
    if (this.deps.readOnly() || this.rows().length === 0) {
      return Promise.resolve()
    }
    return this.deps
      .serialize(() => {
        const rows = this.read()
        const deletion = this.deletion(rows.map((row) => row.messageId))
        const plan = rows.flatMap((row) => {
          const change = legacyQueuedChange(this.deps.state(), row)
          return change ? [journalQueueRowBuilder(this.deps.state, row.messageId, change)] : []
        })
        if (plan.length > 0) {
          this.deps.writer.writeRows(() => plan, deletion)
          return
        }
        // Empty append plans open no transaction, so legacy deletion must commit independently.
        this.deps.database().transaction((db) => deletion.write(db))
        deletion.committed()
        this.deps.committed()
      })
      .catch((error: unknown) => {
        console.warn('[journal-open] queued-message import skipped:', {
          sessionId: this.deps.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  private rows(): readonly QueuedMessageRow[] {
    if (this.stored?.revision !== this.revision) {
      this.stored = { revision: this.revision, rows: this.read() }
    }
    return this.stored.rows
  }

  private read(): QueuedMessageRow[] {
    return this.deps
      .database()
      .db.prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
      )
      .all(this.deps.sessionId)
      .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
  }
}
