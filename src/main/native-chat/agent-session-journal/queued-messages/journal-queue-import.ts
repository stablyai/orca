import { JournalDraftMap, JournalDraftSet } from '../projection/journal-transition-collections'
import { journalInputOrder } from '../input-order/journal-input-order'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalDispatchRowApplies,
  queuedHandOffInDoubt
} from '../projection/journal-dispatch-settlement'
import { legacyQueuedChange } from './journal-queue-legacy-change'

import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalOperationReceipt } from '../writing/journal-row-writer'
import type { JournalQueuedMessagesDeps } from '../journal-store-contracts'
import {
  foldQueuedHandOffInDoubt,
  placeQueuedHandOffInDoubt
} from '../submissions/journal-submission-fold'
import type { QueuedMessageRow } from './queued-message-table'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'
import type Database from '../../../sqlite/sync-database'
// Adopt legacy cards and delete their rows atomically, using the same fold before and after import.
// Retry failed bulk import on next open; do not loop while the host is running.

type LegacyDeps = Pick<
  JournalQueuedMessagesDeps,
  'sessionId' | 'database' | 'state' | 'serialize' | 'readOnly' | 'writer' | 'committed'
>

export class LegacyQueuedCards {
  private revision = 0
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private readonly witnesses = new Map<string, { messageId: string; change: JournalQueuedChange }>()
  private viewed: {
    owner: JournalReducerState
    key: string
    cards: readonly QueuedMessageRow[]
    byId: ReadonlyMap<string, QueuedMessageRow>
    display?: JournalReducerState
    displayThrough?: number
    handedOff: readonly { card: QueuedMessageRow; submission: AgentJournalSubmission }[]
  } | null = null

  constructor(private readonly deps: LegacyDeps) {}

  /** Disable fallback when no readable legacy cards remain; classify retained cards through the live fold. */
  key(): string {
    if (this.rows().length === 0) {
      return ''
    }
    const state = this.deps.state()
    return `${this.revision}:${state.epoch}:${journalInputOrder(state).linkedVersion()}`
  }

  cards(): readonly QueuedMessageRow[] {
    const key = this.key()
    if (key === '') {
      this.viewed = null
      return []
    }
    const state = this.deps.state()
    if (this.viewed?.key !== key || this.viewed.owner !== state) {
      const cards: QueuedMessageRow[] = []
      const handedOff: { card: QueuedMessageRow; submission: AgentJournalSubmission }[] = []
      const byId = new Map<string, QueuedMessageRow>()
      for (const row of this.rows()) {
        const change = this.change(row)
        if (!change) {
          continue
        }
        const card = queuedCardFromChange(state, row.messageId, change)
        cards.push(card)
        byId.set(card.messageId, card)
        const submission = selectedHandOff(state, card)
        if (submission) {
          handedOff.push({ card, submission })
        }
      }
      this.viewed = { owner: state, key, cards, handedOff, byId }
    }
    return this.viewed.cards
  }

  get(messageId: string): QueuedMessageRow | undefined {
    this.cards()
    return this.viewed?.byId.get(messageId)
  }

  // Failed adoption cannot hide spent sends; derive display changes only on copied state.
  displayState(): JournalReducerState {
    const state = this.deps.state()
    this.cards()
    if (this.viewed?.display && this.viewed.displayThrough === state.lastSequence) {
      return this.viewed.display
    }
    const handedOff = this.viewed?.handedOff ?? []
    if (this.viewed) {
      this.viewed.displayThrough = state.lastSequence
    }
    if (handedOff.length === 0) {
      if (this.viewed) {
        this.viewed.display = state
      }
      return state
    }
    const display: JournalReducerState = {
      ...state,
      items: new JournalDraftMap(state.items),
      submissions: new JournalDraftMap(state.submissions),
      normalizedHandOffs: new JournalDraftSet(state.normalizedHandOffs),
      inputs: { ...state.inputs, presentations: new JournalDraftMap(state.inputs.presentations) }
    }
    for (const { card, submission: entry } of handedOff) {
      const send = { ...entry }
      display.submissions.set(send.clientMessageId, send)
      display.inputs.presentations.set(send.clientMessageId, card)
      foldQueuedHandOffInDoubt(send)
      placeQueuedHandOffInDoubt(display, send)
    }
    if (this.viewed) {
      this.viewed.display = display
    }
    return display
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
            const state = this.deps.state()
            for (const send of journalInputOrder(state).linkedTo(row.messageId)) {
              if (journalDispatchRowApplies(send)) {
                this.witnesses.set(send.clientMessageId, { messageId: row.messageId, change })
              }
            }
          }
          return change ? [journalQueueRowBuilder(this.deps.state, row.messageId, change)] : []
        })
        if (plan.length > 0) {
          this.deps.writer.writeRows(() => plan, {
            ...deletion,
            fold: (draft) => {
              for (const row of rows) {
                const card = draft.queue.cards.get(row.messageId)
                const send = card && selectedHandOff(draft, card)
                if (send) {
                  draft.inputs.presentations.set(send.clientMessageId, row)
                  foldQueuedHandOffInDoubt(send)
                  placeQueuedHandOffInDoubt(draft, send)
                }
              }
            }
          })
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
    return readLegacyRows(this.deps.database().db, this.deps.sessionId)
  }
}

export function readJournalLegacyCards(
  db: Database.Database,
  state: JournalReducerState
): QueuedMessageRow[] {
  return readLegacyRows(db, state.sessionId).flatMap((row) => {
    const change = legacyQueuedChange(state, row)
    return change ? [queuedCardFromChange(state, row.messageId, change)] : []
  })
}

function readLegacyRows(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  return db
    .prepare(
      `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`
    )
    .all(sessionId)
    .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
}

function selectedHandOff(
  state: JournalReducerState,
  card: QueuedMessageRow
): AgentJournalSubmission | undefined {
  const id = card.consumedAs ?? card.recovers
  const send = id ? state.submissions.get(id) : undefined
  return send && queuedHandOffInDoubt(send) ? send : undefined
}
