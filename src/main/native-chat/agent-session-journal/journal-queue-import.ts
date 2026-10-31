// Adopt legacy cards and delete their rows atomically, using the same fold before and after import.
// Retry failed bulk import on next open; do not loop while the host is running.

import { dispatchWasWithdrawn } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies, queuedHandOffInDoubt } from './journal-dispatch-settlement'
import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import { queuedChangeOf } from './journal-queue-retention'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import { placeQueuedHandOffInDoubt } from './journal-submission-fold'
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
    ...(unconfirmed?.recovers ? { recovers: unconfirmed.recovers } : {}),
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
  | { attempt: string; holdReason?: undefined; recovers?: undefined }
  | { attempt?: undefined; holdReason: string; recovers?: string }
  | null {
  const attempts = [...state.submissions.values()]
    .filter(
      (submission) =>
        state.inputs.sources.get(submission.clientMessageId)?.queuedMessageId === row.messageId
    )
    .sort((a, b) => (a.submittedSequence ?? 0) - (b.submittedSequence ?? 0))
  if (!attempts.some(handOffInDoubt)) {
    return null
  }
  const latest = attempts.at(-1)!
  return handOffInDoubt(latest) && latest.payloadFingerprint === row.fingerprint
    ? { attempt: latest.clientMessageId }
    : {
        holdReason: QUEUED_MESSAGE_HELD_DELIVERY_UNCONFIRMED,
        ...(handOffInDoubt(latest) && (!dispatchWasWithdrawn(latest) || latest.answeredInTurn)
          ? { recovers: latest.clientMessageId }
          : {})
      }
}

function handOffInDoubt(submission: AgentJournalSubmission): boolean {
  return queuedHandOffInDoubt(submission)
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
  private readonly changes = new Map<string, JournalQueuedChange>()
  private readonly witnesses = new Map<string, { messageId: string; change: JournalQueuedChange }>()
  private viewed: {
    owner: JournalReducerState
    key: string
    cards: readonly QueuedMessageRow[]
  } | null = null

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
      this.viewed = null
      return []
    }
    const state = this.deps.state()
    if (this.viewed?.key !== key || this.viewed.owner !== state) {
      const cards = this.rows().flatMap((row) => {
        const change = this.change(row)
        return change ? [queuedCardFromChange(state, row.messageId, change)] : []
      })
      this.viewed = { owner: state, key, cards }
    }
    return this.viewed.cards
  }

  /** Derived during the existing import pass; the selected operation persists this witness. */
  witness(clientMessageId: string): { messageId: string; change: JournalQueuedChange } | undefined {
    const witness = this.witnesses.get(clientMessageId)
    return witness && !this.deps.state().queue.cards.has(witness.messageId) ? witness : undefined
  }

  witnessRows(
    clientMessageId: string,
    adopted?: string[]
  ): ReturnType<typeof journalQueueRowBuilder>[] {
    const witness = this.witness(clientMessageId)
    if (!witness || adopted?.includes(witness.messageId)) {
      return []
    }
    const row = journalQueueRowBuilder(this.deps.state, witness.messageId, witness.change)
    adopted?.push(witness.messageId)
    return [row]
  }

  /** Resolve adoption on the write lane from current disk state; null means no legacy card. */
  adoption(messageId: string): JournalQueuedChange | null {
    if (this.deps.state().queue.cards.has(messageId) || this.key() === '') {
      return null
    }
    const { db } = this.deps.database()
    const row = db
      .prepare(
        `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? AND message_id = ?`
      )
      .get(this.deps.sessionId, messageId)
    const card = row === undefined ? null : readStoredQueuedMessageRow(row)
    return card && this.change(card)
  }

  private change(row: QueuedMessageRow): JournalQueuedChange | null {
    const state = this.deps.state()
    if (state.queue.cards.has(row.messageId)) {
      return null
    }
    const cached = this.changes.get(row.messageId)
    if (cached) {
      return unanswered(queuedCardFromChange(state, row.messageId, cached), state.submissions)
        ? cached
        : null
    }
    return legacyQueuedChange(state, row)
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

  cleanup(messageIds: readonly string[]): void {
    if (!messageIds.length) {
      return
    }
    const receipt = this.deletion(messageIds)
    try {
      this.deps.database().transaction((db) => receipt.write(db))
      receipt.committed()
    } catch (error) {
      console.warn('[journal-queue] legacy cleanup skipped:', {
        sessionId: this.deps.sessionId,
        error
      })
    }
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
          const change = this.deps.state().queue.cards.has(row.messageId)
            ? null
            : legacyQueuedChange(this.deps.state(), row)
          if (change) {
            this.changes.set(row.messageId, change)
            const state = this.deps.state()
            for (const send of state.submissions.values()) {
              if (
                state.inputs.sources.get(send.clientMessageId)?.queuedMessageId === row.messageId &&
                journalDispatchRowApplies(send)
              ) {
                this.witnesses.set(send.clientMessageId, { messageId: row.messageId, change })
              }
            }
            const selected = change.attempt ?? change.recovers
            const send = selected && state.submissions.get(selected)
            if (send) {
              state.inputs.presentations.set(send.clientMessageId, row)
              placeQueuedHandOffInDoubt(state, send)
            }
          }
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
