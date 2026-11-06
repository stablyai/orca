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
import { writeJournalSqlInputEntityColumns } from './journal-sql-input-entity-columns'
import { journalSqlSubmissionMemberTables } from './journal-sql-submission-member-tables'

const INPUT_ENTITIES = {
  'cards.current': {
    table: 'journal_proj_current_cards',
    id: 'message_id',
    counter: 'current_cards'
  },
  'cards.overlays': {
    table: 'journal_proj_overlay_cards',
    id: 'message_id',
    counter: 'overlay_cards'
  },
  'cards.indexed': {
    table: 'journal_proj_indexed_cards',
    id: 'message_id',
    counter: 'indexed_cards'
  },
  ...journalSqlSubmissionMemberTables,
  'inputs.rejections': {
    table: 'journal_proj_input_rejections',
    id: 'input_id',
    counter: 'rejections'
  },
  'inputs.presentations': {
    table: 'journal_proj_input_presentations',
    id: 'input_id',
    counter: 'presentations'
  },
  'inputs.handovers': {
    table: 'journal_proj_input_handovers',
    id: 'input_id',
    counter: 'handovers'
  },
  'inputs.ends': { table: 'journal_proj_input_ends', id: 'input_id', counter: 'endings' },
  submissions: {
    table: 'journal_proj_submissions',
    id: 'client_message_id',
    counter: 'submissions'
  },
  receipts: { table: 'journal_proj_receipts', id: 'client_message_id', counter: 'receipts' },
  'queue.cards': { table: 'journal_proj_queue_cards', id: 'message_id', counter: 'cards' },
  inputEntries: { table: 'journal_proj_input_entries', id: 'input_id', counter: 'entries' },
  inputCards: { table: 'journal_proj_lineage_cards', id: 'message_id', counter: 'lineage' },
  'inputs.sources': { table: 'journal_proj_input_sources', id: 'input_id', counter: 'sources' }
} as const
type InputEntity = keyof typeof INPUT_ENTITIES

export function journalSqlInputEntity(
  scope: JournalSqlScope,
  collection: string
): JournalSqlInputEntity | undefined {
  if (Object.hasOwn(INPUT_ENTITIES, collection)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fixed domain families above own these tables.
    return new JournalSqlInputEntity(scope, collection as InputEntity)
  }
  return undefined
}

/** Current membership and retained incarnations share the entity's one typed payload home. */
export class JournalSqlInputEntity {
  private readonly table: (typeof INPUT_ENTITIES)[InputEntity]
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly collection: InputEntity
  ) {
    this.table = INPUT_ENTITIES[collection]
  }

  private id(key: string): string {
    return String(JSON.parse(key))
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
      .prepare(`SELECT ordinal, incarnation FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
      .get(...this.scope.prefix, this.id(key))
    return row && this.scope.examined(row)
  }

  private row(location: JournalSqlValueLocation, payload: boolean) {
    const row = this.scope.db
      .prepare(`SELECT ${payload ? 'payload_json' : '1'} AS payload
        ${journalSqlCaptureSelect(this.collection)} FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .get(...this.scope.prefix, this.id(location.key), location.incarnation)
    return row && this.scope.examined(row)
  }

  load(location: JournalSqlValueLocation): StoredJournalSqlValue | undefined {
    const row = this.row(location, true)
    return (
      row &&
      parseJournalSqlValue(row.payload, journalSqlCapturedRefs(this.collection, row), (json) =>
        this.scope.parse(json)
      )
    )
  }

  captured(location: JournalSqlValueLocation) {
    const row = this.row(location, false)
    return row ? journalSqlCapturedRefs(this.collection, row) : []
  }

  private writeCaptures(location: JournalSqlValueLocation, encoded: EncodedJournalSqlValue) {
    const columns = journalSqlCaptureColumns(this.collection, encoded.refs)
    if (columns) {
      this.scope.db
        .prepare(`UPDATE ${this.table.table} SET ${columns.set}
          WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
        .run(...columns.values, ...this.scope.prefix, this.id(location.key), location.incarnation)
    }
  }

  private payload(encoded: EncodedJournalSqlValue): string {
    if (encoded.json === null) {
      throw new Error('journal projection entity values are never undefined')
    }
    return encoded.json
  }

  counters(added: boolean, replaced: boolean) {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    const { counter } = this.table
    return this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET ${counter}_count=${counter}_count+?,
        ${counter}_ordinal=${counter}_ordinal+?, ${counter}_incarnation=${counter}_incarnation+?
        WHERE session_id=? AND epoch=?
        RETURNING ${counter}_ordinal AS next_ordinal, ${counter}_incarnation AS next_incarnation`)
      .get(Number(added), Number(added), Number(replaced), ...this.scope.prefix)!
  }

  importCounters(size: number): void {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_domain_counters (session_id, epoch)
        VALUES (?, ?)`)
      .run(...this.scope.prefix)
    const { counter } = this.table
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters
        SET ${counter}_count=?, ${counter}_ordinal=?, ${counter}_incarnation=?
        WHERE session_id=? AND epoch=?`)
      .run(size, size, size, ...this.scope.prefix)
    if (this.collection === 'inputEntries') {
      this.scope.db
        .prepare(`UPDATE journal_proj_domain_counters SET legacy_entries_count=(
          SELECT COUNT(*) FROM journal_proj_input_entries WHERE session_id=? AND epoch=? AND current=1 AND basis='legacy')
          WHERE session_id=? AND epoch=?`)
        .run(...this.scope.prefix, ...this.scope.prefix)
    }
  }

  store(
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown,
    current: boolean,
    ordinal: number
  ): void {
    if (current) {
      this.legacyDelta(-1, location.key)
      this.scope.db
        .prepare(`UPDATE ${this.table.table} SET current=0
          WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
        .run(...this.scope.prefix, this.id(location.key))
    }
    this.scope.db
      .prepare(`INSERT INTO ${this.table.table}
        (session_id, epoch, ${this.table.id}, incarnation, current, ordinal, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, epoch, ${this.table.id}, incarnation)
        DO UPDATE SET current=excluded.current, payload_json=excluded.payload_json`)
      .run(
        ...this.scope.prefix,
        this.id(location.key),
        location.incarnation,
        Number(current),
        ordinal,
        this.payload(encoded)
      )
    this.writeCaptures(location, encoded)
    writeJournalSqlInputEntityColumns(this.scope, location, value, encoded.refs)
    this.legacyDelta(1, location.key, location.incarnation)
  }

  update(
    location: JournalSqlValueLocation,
    encoded: EncodedJournalSqlValue,
    value: unknown
  ): boolean {
    this.legacyDelta(-1, location.key, location.incarnation)
    const result = this.scope.db
      .prepare(`UPDATE ${this.table.table} SET payload_json=?
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .run(this.payload(encoded), ...this.scope.prefix, this.id(location.key), location.incarnation)
    if (result.changes) {
      this.writeCaptures(location, encoded)
      writeJournalSqlInputEntityColumns(this.scope, location, value, encoded.refs)
      this.legacyDelta(1, location.key, location.incarnation)
    }
    return !!result.changes
  }

  delete(key: string): void {
    this.legacyDelta(-1, key)
    this.scope.db
      .prepare(`UPDATE ${this.table.table} SET current=0
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND current=1`)
      .run(...this.scope.prefix, this.id(key))
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET ${this.table.counter}_count=${this.table.counter}_count-1
        WHERE session_id=? AND epoch=?`)
      .run(...this.scope.prefix)
  }

  remove(location: JournalSqlValueLocation): boolean {
    this.legacyDelta(-1, location.key, location.incarnation)
    return !!this.scope.db
      .prepare(`DELETE FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND ${this.table.id}=? AND incarnation=?`)
      .run(...this.scope.prefix, this.id(location.key), location.incarnation).changes
  }

  keys(limit = -1): string[] {
    return this.scope.db
      .prepare(`SELECT ${this.table.id} AS id FROM ${this.table.table}
        WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal LIMIT ?`)
      .all(...this.scope.prefix, limit)
      .map((row) => JSON.stringify(this.scope.examined(row).id))
  }

  private legacyDelta(delta: number, key: string, incarnation?: number): void {
    if (this.collection !== 'inputEntries') {
      return
    }
    this.scope.db
      .prepare(`UPDATE journal_proj_domain_counters SET legacy_entries_count=legacy_entries_count+?
        WHERE session_id=? AND epoch=? AND EXISTS (SELECT 1 FROM journal_proj_input_entries
          WHERE session_id=? AND epoch=? AND input_id=? AND current=1 AND basis='legacy'
          ${incarnation === undefined ? '' : 'AND incarnation=?'})`)
      .run(
        delta,
        ...this.scope.prefix,
        ...this.scope.prefix,
        this.id(key),
        ...(incarnation === undefined ? [] : [incarnation])
      )
  }
}
