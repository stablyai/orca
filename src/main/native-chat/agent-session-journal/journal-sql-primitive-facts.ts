import { journalSqlPrimitiveTable } from './journal-sql-primitive-tables'
import type { JournalSqlScope } from './journal-sql-scope'
import {
  parseJournalSqlValue,
  type EncodedJournalSqlValue,
  type JournalSqlValueLocation,
  type StoredJournalSqlValue
} from './journal-sql-value-codec'
import {
  journalSqlCaptureColumns,
  journalSqlCaptureSelect,
  journalSqlCapturedRefs
} from './journal-sql-captures'

export type JournalSqlPrimitiveTable = {
  table: string
  id: string
  value: string
  counter: string
  /** The value column holds the entry's saved payload rather than a scalar. */
  payload?: boolean
  group?: { column: string; value: string | number; counterTable: string }
}

export function journalSqlPrimitiveFact(scope: JournalSqlScope, collection: string) {
  const table = journalSqlPrimitiveTable(collection)
  return table && new JournalSqlPrimitiveFact(scope, table, collection)
}

/** Scalar facts have no captured object identity; replacing one keeps only its membership order. */
export class JournalSqlPrimitiveFact {
  private readonly columns: string
  private readonly where: string
  private readonly prefix: (string | number)[]
  private readonly counterTable: string
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly table: JournalSqlPrimitiveTable,
    private readonly collection: string
  ) {
    const columns = ['session_id', 'epoch', ...(table.group ? [table.group.column] : [])]
    this.columns = columns.join(', ')
    this.where = columns.map((column) => `${column}=?`).join(' AND ')
    this.prefix = [...scope.prefix, ...(table.group ? [table.group.value] : [])]
    this.counterTable = table.group?.counterTable ?? 'journal_proj_domain_counters'
  }

  size(): number {
    const row = this.scope.db
      .prepare(`SELECT ${this.table.counter}_count AS size FROM ${this.counterTable}
        WHERE ${this.where}`)
      .get(...this.prefix)
    return row ? Number(this.scope.examined(row).size) : 0
  }

  header(key: string) {
    const row = this.scope.db
      .prepare(`SELECT ordinal, 0 AS incarnation FROM ${this.table.table}
        WHERE ${this.where} AND ${this.table.id}=?`)
      .get(...this.prefix, JSON.parse(key))
    return row && this.scope.examined(row)
  }

  private row(location: JournalSqlValueLocation, value: boolean) {
    const row = this.scope.db
      .prepare(`SELECT ${value ? this.table.value : '1'} AS value
        ${journalSqlCaptureSelect(this.collection)} FROM ${this.table.table}
        WHERE ${this.where} AND ${this.table.id}=?`)
      .get(...this.prefix, JSON.parse(location.key))
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation): StoredJournalSqlValue | undefined {
    const row = this.row(location, true)
    if (!row) {
      return undefined
    }
    return this.table.payload
      ? parseJournalSqlValue(row.value, journalSqlCapturedRefs(this.collection, row), (json) =>
          this.scope.parse(json)
        )
      : { data: [row.value], refs: [] }
  }

  captured(location: JournalSqlValueLocation) {
    const row = this.table.payload ? this.row(location, false) : undefined
    return row ? journalSqlCapturedRefs(this.collection, row) : []
  }

  private writeCaptures(location: JournalSqlValueLocation, encoded: EncodedJournalSqlValue) {
    const columns = journalSqlCaptureColumns(this.collection, encoded.refs)
    if (columns) {
      this.scope.db
        .prepare(`UPDATE ${this.table.table} SET ${columns.set}
          WHERE ${this.where} AND ${this.table.id}=?`)
        .run(...columns.values, ...this.prefix, JSON.parse(location.key))
    }
  }

  counters(added: boolean, _replaced: boolean) {
    this.scope.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.counterTable} (${this.columns}) VALUES (${this.prefix.map(() => '?').join(', ')})`
      )
      .run(...this.prefix)
    const { counter } = this.table
    return this.scope.db
      .prepare(`UPDATE ${this.counterTable} SET ${counter}_count=${counter}_count+?,
        ${counter}_ordinal=${counter}_ordinal+? WHERE ${this.where}
        RETURNING ${counter}_ordinal AS next_ordinal, 0 AS next_incarnation`)
      .get(Number(added), Number(added), ...this.prefix)!
  }

  importCounters(size: number): void {
    this.scope.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.counterTable} (${this.columns}) VALUES (${this.prefix.map(() => '?').join(', ')})`
      )
      .run(...this.prefix)
    this.scope.db
      .prepare(`UPDATE ${this.counterTable}
        SET ${this.table.counter}_count=?, ${this.table.counter}_ordinal=? WHERE ${this.where}`)
      .run(size, size, ...this.prefix)
  }

  store(
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown,
    _current: boolean,
    ordinal: number
  ): void {
    const { table, id, value: column } = this.table
    this.scope.db
      .prepare(`INSERT INTO ${table} (${this.columns}, ${id}, ordinal${column === id ? '' : `, ${column}`})
        VALUES (${this.prefix.map(() => '?').join(', ')}, ?, ?${column === id ? '' : ', ?'}) ON CONFLICT(${this.columns}, ${id})
        DO UPDATE SET ${column}=excluded.${column}`)
      .run(
        ...this.prefix,
        JSON.parse(location.key),
        ordinal,
        ...(column === id ? [] : [this.table.payload ? encoded.json : this.scalar(value)])
      )
    this.writeCaptures(location, encoded)
  }

  private scalar(value: unknown): string | number {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these reducer families admit only strings or finite numbers, with set values stored by key.
    return value as string | number
  }

  update(
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown
  ): boolean {
    const updated = !!this.scope.db
      .prepare(`UPDATE ${this.table.table} SET ${this.table.value}=?
        WHERE ${this.where} AND ${this.table.id}=?`)
      .run(
        this.table.payload ? encoded.json : this.scalar(value),
        ...this.prefix,
        JSON.parse(location.key)
      ).changes
    if (updated) {
      this.writeCaptures(location, encoded)
    }
    return updated
  }

  delete(_key: string): void {
    this.scope.db
      .prepare(`UPDATE ${this.counterTable} SET ${this.table.counter}_count=${this.table.counter}_count-1
        WHERE ${this.where}`)
      .run(...this.prefix)
  }

  remove(location: JournalSqlValueLocation): boolean {
    return !!this.scope.db
      .prepare(`DELETE FROM ${this.table.table} WHERE ${this.where} AND ${this.table.id}=?`)
      .run(...this.prefix, JSON.parse(location.key)).changes
  }

  keys(limit = -1): string[] {
    return this.scope.db
      .prepare(`SELECT ${this.table.id} AS id FROM ${this.table.table}
        WHERE ${this.where} ORDER BY ordinal LIMIT ?`)
      .all(...this.prefix, limit)
      .map((row) => JSON.stringify(this.scope.examined(row).id))
  }
}
