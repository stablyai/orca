import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import type {
  InputPlaceQuery,
  JournalInputPlaceEntry
} from './input-order/journal-input-place-index'
import type { JournalSqlScope } from './journal-sql-scope'

function compareJournalSqlPlaces(a: SqliteRow, b: SqliteRow): number {
  return (
    Number(a.sequence) - Number(b.sequence) ||
    Number(a.tie ?? 0) - Number(b.tie ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  )
}

/** Delivery evidence keyed by a numeric sequence and tie; edges and maxima are indexed seeks. */
export class JournalSqlPlaceIndex implements JournalInputPlaceStorage {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly indexId: string
  ) {}

  private get prefix(): [string, string, string] {
    return [...this.scope.prefix, this.indexId]
  }

  /** An actual open's export writes each restored entry as the memory index holds it. */
  importEntry(entry: JournalInputPlaceEntry): void {
    this.scope.db
      .prepare(`INSERT INTO journal_proj_places
        (session_id, epoch, index_id, id, sequence, tie, position) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(...this.prefix, entry.id, entry.sequence, entry.tie ?? 0, entry.position)
  }

  setPosition(id: string, position: number, tie = 0): void {
    this.scope.db
      .prepare(`INSERT INTO journal_proj_places
        (session_id, epoch, index_id, id, sequence, tie, position) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, epoch, index_id, id) DO UPDATE SET
          sequence=excluded.sequence, tie=excluded.tie, position=excluded.position
        WHERE sequence<>excluded.sequence OR tie<>excluded.tie OR position<>excluded.position`)
      .run(...this.prefix, id, position, tie, position)
  }

  delete(id: string): void {
    this.scope.db
      .prepare(`DELETE FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND id=?`)
      .run(...this.prefix, id)
  }

  isEmpty(): boolean {
    const row = this.scope.db
      .prepare(`SELECT id FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? LIMIT 1`)
      .get(...this.prefix)
    if (row) {
      this.scope.examined(row)
    }
    return !row
  }

  allPlaces(): InputPlaceQuery {
    const row = this.scope.db
      .prepare(`SELECT MAX(position) AS position FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=?`)
      .get(...this.prefix)!
    this.scope.examined(row)
    return { position: row.position === null ? -Infinity : Number(row.position) }
  }

  lastId(): string | undefined {
    return this.edge(true).at(-1)?.id?.toString()
  }

  successorId(sequence: number): string | undefined {
    return this.edge(false, sequence).at(0)?.id?.toString()
  }

  private edge(descending: boolean, after?: number): SqliteRow[] {
    const row = this.scope.db
      .prepare(`SELECT sequence, tie FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? ${after === undefined ? '' : 'AND sequence>?'}
        ORDER BY sequence ${descending ? 'DESC' : 'ASC'}, tie ${descending ? 'DESC' : 'ASC'} LIMIT 1`)
      .get(...this.prefix, ...(after === undefined ? [] : [after]))
    if (!row) {
      return []
    }
    this.scope.examined(row)
    const ties = this.scope.db
      .prepare(`SELECT id, sequence, tie FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND sequence=? AND tie=?`)
      .all(...this.prefix, row.sequence, row.tie)
    ties.forEach((tie) => this.scope.examined(tie))
    return ties.sort(compareJournalSqlPlaces)
  }

  idsAfter(sequence: number): string[] {
    const rows = this.scope.db
      .prepare(`SELECT id, sequence, tie FROM journal_proj_places
        WHERE session_id=? AND epoch=? AND index_id=? AND sequence>? ORDER BY sequence, tie`)
      .all(...this.prefix, sequence)
    rows.forEach((row) => this.scope.examined(row))
    return rows.sort(compareJournalSqlPlaces).map((row) => String(row.id))
  }
}
