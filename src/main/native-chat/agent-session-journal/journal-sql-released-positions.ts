import type { JournalInputReleasedStorage } from './journal-index-storage'
import type { JournalInputReleasedPositions } from './input-order/journal-input-released-positions'
import type { JournalIndexedInputCard } from './input-order/journal-input-card-index'
import type { JournalInputCard } from './input-order/journal-input-lineage'
import type { JournalInputPlace } from './input-order/journal-input-order-state'
import type { InputPlaceQuery } from './input-order/journal-input-place-index'
import type { JournalSqlScope } from './journal-sql-scope'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

export class JournalSqlReleasedPositions implements JournalInputReleasedStorage {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {}

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  /** Releases since the latest pause share its generation; earlier ones keep an older one. */
  importState(state: ReturnType<JournalInputReleasedPositions['exportState']>): void {
    const paused = state.floor !== -Infinity
    const releases = [...state.releases]
    if (!paused && releases.length === 0) {
      return
    }
    this.scope.db
      .prepare(`INSERT INTO journal_proj_release_state
        (session_id, epoch, index_id, floor, pause_gen) VALUES (?, ?, ?, ?, ?)`)
      .run(...this.prefix, paused ? state.floor : null, Number(paused))
    const insert = this.scope.db.prepare(`INSERT INTO journal_proj_releases
      (session_id, epoch, index_id, id, introduced, position, pause_gen)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const entry of releases) {
      insert.run(
        ...this.prefix,
        entry.id,
        entry.sequence,
        entry.position,
        Number(paused && state.sincePause.has(entry.id))
      )
    }
  }

  pause(cut: number): void {
    this.scope.db
      .prepare(`INSERT INTO journal_proj_release_state
        (session_id, epoch, index_id, floor, pause_gen) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(session_id, epoch, index_id) DO UPDATE
        SET floor=excluded.floor, pause_gen=pause_gen+1`)
      .run(...this.prefix, cut)
  }

  delete(prior: JournalIndexedInputCard): void {
    this.scope.db
      .prepare(`DELETE FROM journal_proj_releases
        WHERE session_id=? AND epoch=? AND index_id=? AND id=?`)
      .run(...this.prefix, prior.card.messageId)
  }

  add(card: QueuedMessageRow, source: JournalInputCard): void {
    if (card.state === 'withdrawn') {
      return
    }
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_release_state
        (session_id, epoch, index_id) VALUES (?, ?, ?)`)
      .run(...this.prefix)
    this.scope.db
      .prepare(`INSERT OR REPLACE INTO journal_proj_releases
        (session_id, epoch, index_id, id, introduced, position, pause_gen)
        SELECT session_id, epoch, index_id, ?, ?, ?, pause_gen
        FROM journal_proj_release_state WHERE session_id=? AND epoch=? AND index_id=?`)
      .run(card.messageId, source.introduced, card.position, ...this.prefix)
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    const state = this.scope.db
      .prepare(`SELECT floor, pause_gen FROM journal_proj_release_state
        WHERE session_id=? AND epoch=? AND index_id=?`)
      .get(...this.prefix)
    if (!state) {
      return { position: -Infinity }
    }
    this.scope.examined(state)
    const floor = state.floor === null ? -Infinity : Number(state.floor)
    const exists = this.scope.db
      .prepare(`SELECT id FROM journal_proj_releases
        WHERE session_id=? AND epoch=? AND index_id=? LIMIT 1`)
      .get(...this.prefix)
    if (!exists) {
      return { position: -Infinity }
    }
    this.scope.examined(exists)
    const sincePause = place.context.cut <= floor
    const eligible = this.scope.db
      .prepare(`SELECT MAX(position) AS position FROM journal_proj_releases
          WHERE session_id=? AND epoch=? AND index_id=? ${sincePause ? 'AND pause_gen=?' : ''}
          AND introduced<?`)
      .get(...this.prefix, ...(sincePause ? [state.pause_gen] : []), place.context.cut)!
    this.scope.examined(eligible)
    if (eligible.position !== null) {
      return { position: Number(eligible.position) }
    }
    return { position: -Infinity }
  }
}
