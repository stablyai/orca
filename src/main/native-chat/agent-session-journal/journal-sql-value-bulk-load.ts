import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { encodeJournalSqlValue, type JournalSqlValueLocation } from './journal-sql-value-codec'
import type { JournalSqlDomainTables } from './journal-sql-domain-tables'
import type { JournalSqlItemValues } from './journal-sql-item-values'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalOutcomeItemSource } from './journal-outcome-item-provenance'

/** Items a conversion admitted unchanged from their saved outcome records. */
export type JournalSqlSavedItems = {
  items: JournalSqlItemValues
  source: (item: AgentJournalRenderItem, key: string) => JournalOutcomeItemSource | undefined
}

type Entry = { value: unknown; ordinal: number; incarnation: number }

/** Empty-epoch imports have no replaced incarnations or mutations to track. */
export class JournalSqlValueBulkLoad {
  private readonly collections = new Map<string, Map<string, Entry>>()
  private readonly locations = new WeakMap<object, JournalSqlValueLocation>()

  constructor(
    private readonly tables: JournalSqlDomainTables,
    private readonly saved?: JournalSqlSavedItems
  ) {}

  size(collection: string): number {
    return this.collections.get(collection)?.size ?? 0
  }

  header(collection: string, key: string): SqliteRow | undefined {
    const entry = this.collections.get(collection)?.get(key)
    return entry && { ordinal: entry.ordinal, incarnation: entry.incarnation }
  }

  read<T>(collection: string, key: string): T | undefined {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: typed keyed views own the values written under their collection names.
    return this.collections.get(collection)?.get(key)?.value as T | undefined
  }

  write(collection: string, key: string, value: unknown): void {
    let entries = this.collections.get(collection)
    if (!entries) {
      entries = new Map()
      this.collections.set(collection, entries)
    }
    if (entries.has(key)) {
      throw new Error('Journal bulk load cannot replace an entry')
    }
    const ordinal = entries.size + 1
    const location = { collection, key, incarnation: ordinal, path: [] }
    entries.set(key, { value, ordinal, incarnation: ordinal })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the items collection holds render items.
    const item = collection === 'items' ? (value as AgentJournalRenderItem) : undefined
    const source = item && this.saved?.source(item, key)
    if (item && source) {
      this.locations.set(item, location)
      this.saved!.items.storeSaved(location, item, ordinal, source)
      return
    }
    const encoded = encodeJournalSqlValue(value, location, this.locations, true)
    this.tables.for(collection).store(location, encoded, value, true, ordinal)
  }

  finish(): void {
    for (const [collection, entries] of this.collections) {
      this.tables.for(collection).importCounters(entries.size)
    }
  }
}
