import type { JournalInputReleasedStorage } from './journal-index-storage'
import type { JournalIndexedInputCard } from './journal-input-domain-index'
import type { JournalInputCard } from './journal-input-lineage'
import type { JournalInputPlace } from './journal-input-order-state'
import { mergeInputPlaces, type InputPlaceQuery } from './journal-input-place-index'
import { JournalSqlDomainIndex } from './journal-sql-domain-index'
import type { JournalSqlScope } from './journal-sql-scope'
import type { QueuedMessageRow } from './queued-message-table'

export class JournalSqlReleasedPositions implements JournalInputReleasedStorage {
  private readonly domains: JournalSqlDomainIndex
  private readonly fallback: JournalSqlDomainIndex

  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {
    this.domains = new JournalSqlDomainIndex(scope, `${indexId}:released-at`)
    this.fallback = new JournalSqlDomainIndex(scope, `${indexId}:released-fallback`)
    scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_release_state
        (session_id, generation, index_id) VALUES (?, ?, ?)`)
      .run(...this.prefix)
  }

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  pause(cut: number): void {
    this.scope.db
      .prepare(`UPDATE journal_proj_release_state SET floor=?, pause_gen=pause_gen+1
        WHERE session_id=? AND generation=? AND index_id=?`)
      .run(cut, ...this.prefix)
  }

  delete(prior: JournalIndexedInputCard): void {
    if (prior.releasedAt !== undefined) {
      this.domains.delete(prior.card, { ...prior.source, introduced: prior.releasedAt })
    } else {
      this.fallback.delete(prior.card, prior.source)
    }
    this.scope.db
      .prepare(`DELETE FROM journal_proj_releases
        WHERE session_id=? AND generation=? AND index_id=? AND id=?`)
      .run(...this.prefix, prior.card.messageId)
  }

  add(card: QueuedMessageRow, source: JournalInputCard, releasedAt?: number): void {
    if (releasedAt !== undefined) {
      this.domains.setPosition(card, { ...source, introduced: releasedAt })
    } else {
      this.fallback.setPosition(card, source)
    }
    if (card.state === 'withdrawn') {
      return
    }
    this.scope.db
      .prepare(`INSERT OR REPLACE INTO journal_proj_releases
        (session_id, generation, index_id, id, introduced, position, pause_gen)
        SELECT session_id, generation, index_id, ?, ?, ?, pause_gen
        FROM journal_proj_release_state WHERE session_id=? AND generation=? AND index_id=?`)
      .run(card.messageId, source.introduced, card.position, ...this.prefix)
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    const state = this.scope.db
      .prepare(`SELECT floor, pause_gen FROM journal_proj_release_state
        WHERE session_id=? AND generation=? AND index_id=?`)
      .get(...this.prefix)
    if (!state) {
      throw new Error('Missing released-position state')
    }
    this.scope.examined(state)
    const floor = state.floor === null ? -Infinity : Number(state.floor)
    const exists = this.scope.db
      .prepare(`SELECT id FROM journal_proj_releases
        WHERE session_id=? AND generation=? AND index_id=? LIMIT 1`)
      .get(...this.prefix)
    if (!exists) {
      return { position: -Infinity }
    }
    this.scope.examined(exists)
    if (place.context.basis === 'observed') {
      const sincePause = place.context.cut <= floor
      const positions = this.scope.db
        .prepare(`SELECT position, introduced FROM journal_proj_releases
          WHERE session_id=? AND generation=? AND index_id=? ${sincePause ? 'AND pause_gen=?' : ''}
          ORDER BY position DESC`)
        .iterate(...this.prefix, ...(sincePause ? [state.pause_gen] : []))
      for (const row of positions) {
        this.scope.examined(row)
        if (Number(row.introduced) < place.context.cut) {
          return { position: Number(row.position) }
        }
      }
    } else if (place.context.cut > floor) {
      return mergeInputPlaces(
        this.domains.query({ ...place.context, cut: floor }, place.original),
        this.fallback.query(place.context, place.original)
      )
    }
    return { position: -Infinity }
  }
}
