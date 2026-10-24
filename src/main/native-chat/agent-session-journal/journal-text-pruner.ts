import type { JournalStoreHost } from './journal-store-collaborators'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { deleteJournalTextRange } from './journal-row-table'
import { journalTextFields, journalWholeItem } from './journal-text-rows'

/** One bounded unit per queue turn; failure retains the pieces and stops this drain. */
export class JournalTextPruner {
  private scheduled: ReturnType<typeof setImmediate> | null = null
  private drain: 'open' | 'failed' | 'closed' = 'open'

  constructor(private readonly host: JournalStoreHost) {}

  committed(rows: readonly JournalRow[]): void {
    if (this.drain === 'closed') {
      return
    }
    if (rows.some((row) => row.kind === 'item' || row.kind === 'lifecycle-batch')) {
      this.drain = 'open'
      if (this.attempt()) {
        this.schedule()
      }
    } else {
      this.schedule()
    }
  }

  schedule(): void {
    if (
      this.drain !== 'open' ||
      this.scheduled ||
      this.host.readOnly() ||
      !this.host.state().textIndex.ready.size
    ) {
      return
    }
    const epoch = this.host.state().epoch
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this.drain !== 'open' || this.host.state().epoch !== epoch) {
        return
      }
      void this.host
        .serialize(() => this.attempt())
        .then(
          (ok) => {
            if (ok) {
              this.schedule()
            }
          },
          (error: unknown) => this.failed(error)
        )
    })
    const timer: unknown = this.scheduled
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  close(): void {
    this.drain = 'closed'
    if (this.scheduled) {
      clearImmediate(this.scheduled)
    }
    this.scheduled = null
  }

  private attempt(): boolean {
    if (this.drain !== 'open' || this.host.readOnly()) {
      return false
    }
    try {
      this.pruneOne()
      return true
    } catch (error) {
      if (this.scheduled) {
        clearImmediate(this.scheduled)
      }
      this.scheduled = null
      this.failed(error)
      return false
    }
  }

  private failed(error: unknown): void {
    if (this.drain !== 'closed') {
      this.drain = 'failed'
    }
    console.warn('[journal-text-prune] keeping saved text pieces:', {
      sessionId: this.host.identity.sessionId,
      error
    })
  }

  private pruneOne(): void {
    const state = this.host.state()
    const key = state.textIndex.ready.values().next().value
    if (key === undefined) {
      return
    }
    const piece = state.textIndex.pieces.get(key)
    if (!piece) {
      return
    }
    let commit: (() => void) | undefined
    this.host.database().transaction((db) => {
      let remaining = 256
      const decoded = new Map<number, JournalRow>()
      const read = (seq: number): JournalRow => {
        const cached = decoded.get(seq)
        if (cached) {
          return cached
        }
        if (--remaining < 0) {
          throw new Error('journal_text_prune_budget_exceeded')
        }
        const stored = db
          .prepare(
            'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
          )
          .get(this.host.identity.sessionId, state.epoch, seq)
        const parsed =
          typeof stored?.row_json === 'string' ? parseJournalRow(stored.row_json, true) : null
        if (!parsed?.ok || parsed.row.seq !== seq || parsed.row.epoch !== state.epoch) {
          throw new Error('journal_text_prune_row_invalid')
        }
        decoded.set(seq, parsed.row)
        return parsed.row
      }
      const boundary = read(state.textIndex.sparseAfter ?? 0)
      const marker = read(piece.marker?.seq ?? 0)
      const witness = read(piece.witness?.seq ?? 0)
      const anchor = marker.kind === 'item' ? journalWholeItem(marker, piece.itemId) : undefined
      const whole =
        witness.kind === 'item' || witness.kind === 'lifecycle-batch'
          ? journalWholeItem(witness, piece.itemId, piece.revision)
          : undefined
      if (
        boundary.kind !== 'item' ||
        boundary.v < 5 ||
        !journalTextFields(boundary.body).length ||
        marker.kind !== 'item' ||
        marker.v < 5 ||
        !anchor ||
        !whole ||
        anchor.revision !== piece.marker?.revision ||
        anchor.revision >= whole.revision ||
        marker.seq >= witness.seq ||
        (witness.kind === 'lifecycle-batch' &&
          witness.settlementId !== piece.witness?.settlementId) ||
        !journalTextFields(anchor.body).includes(piece.field) ||
        !journalTextFields(whole.body).includes(piece.field) ||
        state.replayTextDebt?.size
      ) {
        throw new Error('journal_text_prune_witness_invalid')
      }
      const selection = state.textIndex.select(key, piece, remaining)
      for (const seq of selection.sequences) {
        const target = read(seq)
        if (
          target.kind !== 'text-delta' ||
          target.itemId !== piece.itemId ||
          target.field !== piece.field ||
          target.revision >= whole.revision ||
          target.seq <= marker.seq ||
          target.seq >= witness.seq ||
          target.seq >= state.lastSequence ||
          state.textIndex.isProtected(seq)
        ) {
          throw new Error('journal_text_prune_target_invalid')
        }
      }
      for (const [first, last] of selection.ranges) {
        deleteJournalTextRange(db, this.host.identity.sessionId, state.epoch, first, last)
      }
      commit = selection.commit
    })
    commit?.()
  }
}
