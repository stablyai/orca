import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlValueLocation } from './journal-sql-value-codec'

const FACTS = {
  aliases: { table: 'journal_proj_aliases', id: 'alias', value: 'target', counter: 'aliases' },
  itemFences: {
    table: 'journal_proj_item_fences',
    id: 'item_id',
    value: 'fence',
    counter: 'item_fences'
  },
  itemExecutionOwners: {
    table: 'journal_proj_item_execution_owners',
    id: 'item_id',
    value: 'fence',
    counter: 'execution_owners'
  },
  providerActivityAt: {
    table: 'journal_proj_provider_activity',
    id: 'fence',
    value: 'observed_at',
    counter: 'provider_activity'
  },
  tombstones: {
    table: 'journal_proj_tombstones',
    id: 'item_id',
    value: 'revision',
    counter: 'tombstones'
  },
  removedTurnIds: {
    table: 'journal_proj_removed_turns',
    id: 'turn_id',
    value: 'turn_id',
    counter: 'removed_turns'
  },
  appliedSettlementIds: {
    table: 'journal_proj_settlements',
    id: 'settlement_id',
    value: 'settlement_id',
    counter: 'settlements'
  },
  normalizedHandOffs: {
    table: 'journal_proj_normalized_handoffs',
    id: 'input_id',
    value: 'input_id',
    counter: 'normalized_handoffs'
  }
} as const
type Fact = keyof typeof FACTS

export function journalSqlPrimitiveFact(
  scope: JournalSqlScope,
  collection: string
): JournalSqlPrimitiveFact | undefined {
  if (Object.hasOwn(FACTS, collection)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each named scalar family has its fixed typed table above.
    return new JournalSqlPrimitiveFact(scope, collection as Fact)
  }
  return undefined
}

/** Scalar facts have no captured object identity; replacing one keeps only its membership order. */
class JournalSqlPrimitiveFact {
  private readonly table: (typeof FACTS)[Fact]
  constructor(
    private readonly scope: JournalSqlScope,
    collection: Fact
  ) {
    this.table = FACTS[collection]
  }

  size(): number {
    const row = this.scope.db
      .prepare(`SELECT ${this.table.counter}_count AS size FROM journal_proj_domain_counters
        WHERE session_id=? AND epoch=?`)
      .get(...this.scope.prefix)
    return row ? Number(this.scope.examined(row).size) : 0
  }

  header(key: string) {
    const row = this.scope.db
      .prepare(`SELECT ordinal, 0 AS incarnation FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=?`)
      .get(...this.scope.prefix, JSON.parse(key))
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation) {
    const row = this.scope.db
      .prepare(`SELECT ${this.table.value} AS value FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=?`)
      .get(...this.scope.prefix, JSON.parse(location.key))
    return (
      row && { value_json: JSON.stringify({ data: [this.scope.examined(row).value], refs: [] }) }
    )
  }

  counters(added: boolean, _replaced: boolean) {
    this.scope.db
      .prepare(
        'INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch) VALUES (?, ?)'
      )
      .run(...this.scope.prefix)
    const { counter } = this.table
    return this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET ${counter}_count=${counter}_count+?,
        ${counter}_ordinal=${counter}_ordinal+? WHERE session_id=? AND epoch=?
        RETURNING ${counter}_ordinal AS next_ordinal, 0 AS next_incarnation`)
      .get(Number(added), Number(added), ...this.scope.prefix)!
  }

  importCounters(size: number): void {
    this.scope.db
      .prepare(
        'INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch) VALUES (?, ?)'
      )
      .run(...this.scope.prefix)
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters
        SET ${this.table.counter}_count=?, ${this.table.counter}_ordinal=? WHERE session_id=? AND epoch=?`)
      .run(size, size, ...this.scope.prefix)
  }

  store(
    location: JournalSqlValueLocation,
    _json: string,
    value: unknown,
    _current: boolean,
    ordinal: number
  ): void {
    const { table, id, value: column } = this.table
    this.scope.db
      .prepare(`INSERT INTO ${table} (session_id, epoch, ${id}, ordinal${column === id ? '' : `, ${column}`})
        VALUES (?, ?, ?, ?${column === id ? '' : ', ?'}) ON CONFLICT(session_id, epoch, ${id})
        DO UPDATE SET ${column}=excluded.${column}`)
      .run(
        ...this.scope.prefix,
        JSON.parse(location.key),
        ordinal,
        ...(column === id ? [] : [this.scalar(value)])
      )
  }

  private scalar(value: unknown): string | number {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these reducer families admit only strings or finite numbers, with set values stored by key.
    return value as string | number
  }

  update(location: JournalSqlValueLocation, _json: string, value: unknown): boolean {
    return !!this.scope.db
      .prepare(`UPDATE ${this.table.table} SET ${this.table.value}=?
        WHERE session_id=? AND epoch=? AND ${this.table.id}=?`)
      .run(this.scalar(value), ...this.scope.prefix, JSON.parse(location.key)).changes
  }

  delete(_key: string): void {
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET ${this.table.counter}_count=${this.table.counter}_count-1
        WHERE session_id=? AND epoch=?`)
      .run(...this.scope.prefix)
  }

  remove(location: JournalSqlValueLocation): boolean {
    return !!this.scope.db
      .prepare(
        `DELETE FROM ${this.table.table} WHERE session_id=? AND epoch=? AND ${this.table.id}=?`
      )
      .run(...this.scope.prefix, JSON.parse(location.key)).changes
  }

  keys(limit = -1): string[] {
    return this.scope.db
      .prepare(`SELECT ${this.table.id} AS id FROM ${this.table.table}
        WHERE session_id=? AND epoch=? ORDER BY ordinal LIMIT ?`)
      .all(...this.scope.prefix, limit)
      .map((row) => JSON.stringify(this.scope.examined(row).id))
  }
}
