import { finishJournalSteps, finishJournalStepsAsync } from './journal-reconstruction-steps'
import type { JournalReadConnection } from './journal-sql-owner'
import type Database from '../../sqlite/sync-database'
import { journalInputOrder } from './journal-input-order'
import {
  legacyQueuedChange,
  legacyQueuedChangeSteps,
  handOffInDoubt
} from './journal-queue-legacy-change'
export { legacyQueuedChange } from './journal-queue-legacy-change'
// Adopt legacy cards and delete their rows atomically, using the same fold before and after import.
// Retry failed bulk import on next open; do not loop while the host is running.

import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalQueueRowBuilder, type JournalQueuedChange } from './journal-queue-events'
import { queuedCardFromChange } from './journal-queue-fold'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalQueuedMessagesDeps } from './journal-store-contracts'
import { foldQueuedHandOffInDoubt } from './journal-submission-fold'
import type { QueuedMessageRow } from './queued-message-table'
import {
  LEGACY_QUEUED_MESSAGE_COLUMNS,
  readStoredQueuedMessageRow
} from './queued-message-stored-row'

type LegacyDeps = Pick<
  JournalQueuedMessagesDeps,
  'sessionId' | 'database' | 'state' | 'serialize' | 'readOnly' | 'writer' | 'committed'
>

export class LegacyQueuedCards {
  private revision = 0
  private stored: { revision: number; rows: readonly QueuedMessageRow[] } | null = null
  private viewed: {
    owner: JournalReducerState
    key: string
    cards: readonly QueuedMessageRow[]
    byId: ReadonlyMap<string, QueuedMessageRow>
    display?: JournalReducerState
    displayThrough?: number
    handedOff: readonly AgentJournalSubmission[]
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
    return finishJournalSteps(this.cardSteps())
  }
  cardsAsync(): Promise<readonly QueuedMessageRow[]> {
    return finishJournalStepsAsync(this.cardSteps())
  }
  private *cardSteps(): Generator<void, readonly QueuedMessageRow[]> {
    const key = this.key()
    if (key === '') {
      this.viewed = null
      return []
    }
    const state = this.deps.state()
    if (this.viewed?.key !== key || this.viewed.owner !== state) {
      const cards: QueuedMessageRow[] = []
      const handedOff: AgentJournalSubmission[] = []
      const byId = new Map<string, QueuedMessageRow>()
      for (const row of this.rows()) {
        const change = yield* legacyQueuedChangeSteps(state, row)
        if (change) {
          const card = queuedCardFromChange(state, row.messageId, change)
          cards.push(card)
          byId.set(card.messageId, card)
          const submission =
            card.consumedAs === null ? undefined : state.submissions.get(card.consumedAs)
          if (submission && handOffInDoubt(submission)) {
            handedOff.push(submission)
          }
        }
        yield
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
    const display = {
      ...state,
      normalizedHandOffs: new Set(state.normalizedHandOffs),
      items: new Map(state.items),
      submissions: new Map(state.submissions)
    }
    for (const entry of handedOff) {
      const submission = { ...entry }
      display.submissions.set(submission.clientMessageId, submission)
      foldQueuedHandOffInDoubt(display, submission)
    }
    if (this.viewed) {
      this.viewed.display = display
    }
    return display
  }

  /** Resolve adoption on the write lane from current disk state; null means no legacy card. */
  adoption(messageId: string): JournalQueuedChange | null {
    if (this.key() === '') {
      return null
    }
    const card = this.rows().find((row) => row.messageId === messageId) ?? null
    return card && legacyQueuedChange(this.deps.state(), card)
  }

  /** Delete in the caller's transaction and refresh the view after commit. */
  deletion(messageIds: readonly string[]): JournalOperationReceipt {
    return {
      write: (db) => {
        db.add({ kind: 'queue-delete', sessionId: this.deps.sessionId, ids: [...messageIds] })
      },
      committed: () => {
        if (messageIds.length) {
          this.revision++
          const removed = new Set(messageIds)
          this.stored = {
            revision: this.revision,
            rows: this.rows().filter((row) => !removed.has(row.messageId))
          }
        }
      }
    }
  }

  messageIds(): string[] {
    return this.rows().map((row) => row.messageId)
  }

  deletionOfAll(): JournalOperationReceipt {
    return this.deletion(this.messageIds())
  }

  async deletionOfAllAsync(): Promise<JournalOperationReceipt> {
    const ids: string[] = []
    await finishJournalStepsAsync(
      (function* (rows: readonly QueuedMessageRow[]) {
        for (const row of rows) {
          ids.push(row.messageId)
          yield
        }
      })(this.rows())
    )
    return {
      write: (db) => {
        db.add({ kind: 'queue-delete', sessionId: this.deps.sessionId, ids })
      },
      committed: () => {
        if (ids.length) {
          this.revision++
          this.stored = { revision: this.revision, rows: [] }
        }
      }
    }
  }

  /** Atomically adopt readable unanswered cards and delete legacy rows; failure leaves both unchanged. */
  importAtOpen(): Promise<void> {
    if (this.deps.readOnly() || this.rows().length === 0) {
      return Promise.resolve()
    }
    return this.deps
      .serialize(async () => {
        const rows = this.rows()
        const deletion = await this.deletionOfAllAsync()
        const state = this.deps.state()
        const plan = await finishJournalStepsAsync(
          (function* (owner: LegacyQueuedCards) {
            const builders: ReturnType<typeof journalQueueRowBuilder>[] = []
            for (const row of rows) {
              const change = yield* legacyQueuedChangeSteps(state, row)
              if (change) {
                builders.push(journalQueueRowBuilder(owner.deps.state, row.messageId, change))
              }
              yield
            }
            return builders
          })(this)
        )
        if (plan.length > 0) {
          await this.deps.writer.writeRows(() => plan, deletion)
          return
        }
        // Empty append plans open no transaction, so legacy deletion must commit independently.
        await this.deps.database().transaction(
          (db) => deletion.write(db),
          false,
          () => {
            deletion.committed()
            this.deps.committed()
          }
        )
      })
      .catch((error: unknown) => {
        console.warn('[journal-open] queued-message import skipped:', {
          sessionId: this.deps.sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  async initialize(): Promise<void> {
    const rows = await this.deps
      .database()
      .read((read) => readLegacyRowsAsync(read, this.deps.sessionId))
    this.stored = { revision: this.revision, rows }
  }

  private rows(): readonly QueuedMessageRow[] {
    if (!this.stored) {
      throw new Error('legacy journal cards were not loaded')
    }
    return this.stored.rows
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

export async function readLegacyRowsAsync(
  read: JournalReadConnection,
  sessionId: string
): Promise<QueuedMessageRow[]> {
  const rows: QueuedMessageRow[] = []
  for await (const page of read.pages(
    `SELECT ${LEGACY_QUEUED_MESSAGE_COLUMNS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC`,
    [sessionId]
  )) {
    for (const row of page) {
      const stored = readStoredQueuedMessageRow(row)
      if (stored) {
        rows.push(stored)
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return rows
}

export async function readJournalLegacyCardsAsync(
  read: JournalReadConnection,
  state: JournalReducerState
): Promise<QueuedMessageRow[]> {
  const rows = await readLegacyRowsAsync(read, state.sessionId)
  function* convert(): Generator<void, QueuedMessageRow[]> {
    const cards: QueuedMessageRow[] = []
    for (const row of rows) {
      const change = yield* legacyQueuedChangeSteps(state, row)
      if (change) {
        cards.push(queuedCardFromChange(state, row.messageId, change))
      }
      yield
    }
    return cards
  }
  return finishJournalStepsAsync(convert())
}
