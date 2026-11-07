import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalSqlDomainTables } from './journal-sql-domain-tables'
import type {
  EncodedJournalSqlValue,
  JournalSqlValueLocation,
  JournalSqlValueReference
} from './journal-sql-value-codec'
import { journalSqlCaptureHolders, journalSqlSourceId } from './journal-sql-captures'

export type JournalSqlDetachedValue = {
  encoded: EncodedJournalSqlValue
  raw: unknown
  /** Unchanged since it was read, so an item may keep its saved outcome pointer. */
  unchanged: boolean
}

/**
 * A replaced entity incarnation stays saved while some holder row captures it, and is removed
 * with the last capture, as are the incarnations it captured in turn.
 */
export class JournalSqlValueReferences {
  constructor(
    private readonly scope: JournalSqlScope,
    private readonly tables: JournalSqlDomainTables,
    private readonly detached: (
      location: JournalSqlValueLocation
    ) => JournalSqlDetachedValue | undefined
  ) {}

  referenced(location: JournalSqlValueLocation): boolean {
    const id = journalSqlSourceId(location.collection, location.key)
    return journalSqlCaptureHolders(location.collection).some(
      ({ table, id: column, incarnation }) => {
        const row = this.scope.db
          .prepare(`SELECT 1 AS held FROM ${table}
          WHERE session_id=? AND epoch=? AND ${column}=? AND ${incarnation}=? LIMIT 1`)
          .get(...this.scope.prefix, id, location.incarnation)
        return !!row && !!this.scope.examined(row)
      }
    )
  }

  captured(location: JournalSqlValueLocation): JournalSqlValueLocation[] {
    return this.tables
      .for(location.collection)
      .captured(location)
      .map((ref) => ref.source)
  }

  /** A holder row now captures `next` instead of `previous`. */
  replace(previous: JournalSqlValueLocation[], next: readonly JournalSqlValueReference[]): void {
    for (const { source } of next) {
      this.ensureSaved(source)
    }
    this.prune(previous)
  }

  /** Removes a holder incarnation no one captures, then releases what it captured. */
  drop(location: JournalSqlValueLocation): void {
    const previous = this.captured(location)
    this.tables.for(location.collection).remove(location)
    this.prune(previous)
  }

  update(location: JournalSqlValueLocation, encoded: EncodedJournalSqlValue, value: unknown) {
    const entity = this.tables.for(location.collection)
    return {
      stored: entity.update(location, encoded, value),
      current: Number(entity.header(location.key)?.incarnation) === location.incarnation
    }
  }

  /** A capture of an incarnation replaced earlier in this command saves that incarnation. */
  private ensureSaved(location: JournalSqlValueLocation): void {
    const entity = this.tables.for(location.collection)
    if (
      Number(entity.header(location.key)?.incarnation) === location.incarnation ||
      entity.load(location)
    ) {
      return
    }
    const detached = this.detached(location)
    if (!detached) {
      throw new Error('Missing journal projection object incarnation')
    }
    entity.store(location, detached.encoded, detached.raw, false, 0, detached.unchanged)
    this.replace([], detached.encoded.refs)
  }

  private prune(locations: JournalSqlValueLocation[]): void {
    for (const location of locations) {
      const entity = this.tables.for(location.collection)
      if (
        Number(entity.header(location.key)?.incarnation) === location.incarnation ||
        this.referenced(location)
      ) {
        continue
      }
      const captured = this.captured(location)
      if (entity.remove(location)) {
        locations.push(...captured)
      }
    }
  }
}
