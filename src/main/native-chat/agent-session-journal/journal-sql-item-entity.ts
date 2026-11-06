import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type {
  EncodedJournalSqlValue,
  JournalSqlValueLocation,
  StoredJournalSqlValue
} from './journal-sql-value-codec'

/** Current items are their history rows; replaced incarnations live on only as versions. */
export class JournalSqlItemEntity {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly items: JournalSqlItemValues
  ) {}

  size(): number {
    const row = this.scope.db
      .prepare(`SELECT items_count AS size FROM journal_proj_domain_counters
        WHERE session_id=? AND epoch=?`)
      .get(...this.scope.prefix)
    return row ? Number(this.scope.examined(row).size) : 0
  }

  header(key: string) {
    const row = this.scope.db
      .prepare(`SELECT ordinal, incarnation FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND entry_key=?`)
      .get(...this.scope.prefix, key)
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation): StoredJournalSqlValue | undefined {
    return this.items.load(location)
  }

  captured(_location: JournalSqlValueLocation) {
    return []
  }

  counters(added: boolean, replaced: boolean) {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    return this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET items_count=items_count+?,
        items_ordinal=items_ordinal+?, items_incarnation=items_incarnation+?
        WHERE session_id=? AND epoch=?
        RETURNING items_ordinal AS next_ordinal, items_incarnation AS next_incarnation`)
      .get(Number(added), Number(added), Number(replaced), ...this.scope.prefix)!
  }

  importCounters(size: number): void {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters
        SET items_count=?, items_ordinal=?, items_incarnation=? WHERE session_id=? AND epoch=?`)
      .run(size, size, size, ...this.scope.prefix)
  }

  store(
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown,
    current: boolean,
    ordinal: number,
    preserve = false
  ): void {
    this.items.store(location, this.payload(encoded), value, current, ordinal, preserve)
  }

  update(location: JournalSqlValueLocation, encoded: EncodedJournalSqlValue, value: unknown) {
    if (!this.items.stored(location)) {
      return false
    }
    const header = this.header(location.key)
    this.items.store(
      location,
      this.payload(encoded),
      value,
      Number(header?.incarnation) === location.incarnation,
      Number(header?.ordinal ?? 0)
    )
    return true
  }

  delete(key: string): void {
    this.items.delete(key)
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET items_count=items_count-1
        WHERE session_id=? AND epoch=?`)
      .run(...this.scope.prefix)
  }

  remove(location: JournalSqlValueLocation): boolean {
    return this.items.forget(location)
  }

  keys(limit = -1): string[] {
    return this.scope.db
      .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? ORDER BY ordinal LIMIT ?`)
      .all(...this.scope.prefix, limit)
      .map((row) => String(this.scope.examined(row).entry_key))
  }

  private payload(encoded: EncodedJournalSqlValue): string {
    if (encoded.json === null) {
      throw new Error('journal items are never undefined')
    }
    return encoded.json
  }
}
