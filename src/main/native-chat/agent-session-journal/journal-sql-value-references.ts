import type { JournalSqlScope } from './journal-sql-scope'
import type {
  JournalSqlValueLocation,
  JournalSqlValueReference,
  EncodedJournalSqlValue
} from './journal-sql-value-codec'

export class JournalSqlValueReferences {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly detached: (
      location: JournalSqlValueLocation
    ) => EncodedJournalSqlValue | undefined
  ) {}

  retain(location: JournalSqlValueLocation): void {
    this.scope.db
      .prepare(`INSERT OR IGNORE INTO journal_proj_value_snapshots
      (session_id, generation, collection, entry_key, incarnation, value_json)
      SELECT session_id, generation, collection, entry_key, incarnation, value_json
      FROM journal_proj_values WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .run(...this.scope.prefix, location.collection, location.key)
  }

  private current(location: JournalSqlValueLocation) {
    const row = this.scope.db
      .prepare(`SELECT incarnation FROM journal_proj_values
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=?`)
      .get(...this.scope.prefix, location.collection, location.key)
    return row && this.scope.examined(row)
  }

  referenced(location: JournalSqlValueLocation): boolean {
    const row = this.scope.db
      .prepare(`SELECT holder_key FROM journal_proj_value_refs
      WHERE session_id=? AND generation=? AND source_collection=? AND source_key=? AND source_incarnation=? LIMIT 1`)
      .get(...this.scope.prefix, location.collection, location.key, location.incarnation)
    if (row) {
      this.scope.examined(row)
    }
    return !!row
  }

  replace(location: JournalSqlValueLocation, refs: JournalSqlValueReference[]): void {
    const previous = this.references(location)
    this.removeReferences(location)
    for (const { source } of refs) {
      this.ensureSnapshot(source)
      this.scope.db
        .prepare(`INSERT OR IGNORE INTO journal_proj_value_refs
        (session_id, generation, holder_collection, holder_key, holder_incarnation,
         source_collection, source_key, source_incarnation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          ...this.scope.prefix,
          location.collection,
          location.key,
          location.incarnation,
          source.collection,
          source.key,
          source.incarnation
        )
    }
    this.prune(previous)
  }

  private ensureSnapshot(location: JournalSqlValueLocation): void {
    const active = this.current(location)
    if (Number(active?.incarnation) === location.incarnation) {
      return
    }
    const snapshot = this.scope.db
      .prepare(`SELECT incarnation FROM journal_proj_value_snapshots
      WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
      .get(...this.scope.prefix, location.collection, location.key, location.incarnation)
    if (snapshot) {
      this.scope.examined(snapshot)
      return
    }
    const encoded = this.detached(location)
    if (!encoded) {
      throw new Error('Missing journal projection object incarnation')
    }
    this.scope.db
      .prepare(`INSERT INTO journal_proj_value_snapshots
      (session_id, generation, collection, entry_key, incarnation, value_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        ...this.scope.prefix,
        location.collection,
        location.key,
        location.incarnation,
        encoded.json
      )
    this.replace(location, encoded.refs)
  }

  private references(location: JournalSqlValueLocation): JournalSqlValueLocation[] {
    return this.scope.db
      .prepare(`SELECT source_collection, source_key, source_incarnation
      FROM journal_proj_value_refs WHERE session_id=? AND generation=?
      AND holder_collection=? AND holder_key=? AND holder_incarnation=?`)
      .all(...this.scope.prefix, location.collection, location.key, location.incarnation)
      .map((row) => {
        this.scope.examined(row)
        return {
          collection: String(row.source_collection),
          key: String(row.source_key),
          incarnation: Number(row.source_incarnation),
          path: []
        }
      })
  }

  private removeReferences(location: JournalSqlValueLocation): void {
    this.scope.db
      .prepare(`DELETE FROM journal_proj_value_refs WHERE session_id=? AND generation=?
      AND holder_collection=? AND holder_key=? AND holder_incarnation=?`)
      .run(...this.scope.prefix, location.collection, location.key, location.incarnation)
  }

  drop(location: JournalSqlValueLocation): void {
    const previous = this.references(location)
    this.removeReferences(location)
    this.prune(previous)
  }

  private prune(locations: JournalSqlValueLocation[]): void {
    for (const location of locations) {
      const active = this.current(location)
      if (Number(active?.incarnation) === location.incarnation || this.referenced(location)) {
        continue
      }
      const removed = this.scope.db
        .prepare(`DELETE FROM journal_proj_value_snapshots
        WHERE session_id=? AND generation=? AND collection=? AND entry_key=? AND incarnation=?`)
        .run(...this.scope.prefix, location.collection, location.key, location.incarnation)
      if (removed.changes) {
        locations.push(...this.references(location))
        this.removeReferences(location)
      }
    }
  }
}
