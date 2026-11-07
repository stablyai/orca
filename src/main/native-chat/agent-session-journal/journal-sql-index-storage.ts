import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  JournalIndexStorageFactory,
  JournalNewestTurnStorage,
  JournalSubmissionStorage
} from './journal-index-storage'
import type { JournalKeyedMap } from './journal-keyed-storage'
import type { JournalStateQueries } from './journal-state-queries'
import {
  JournalSqlKeyedMap,
  JournalSqlKeyedSet,
  journalSqlEntryKey,
  journalSqlOrderedValues
} from './journal-sql-keyed-values'
import { JournalSqlPlaceIndex } from './journal-sql-place-index'
import { JournalSqlQueuedRows } from './journal-sql-queued-rows'
import { JournalSqlTurnSources } from './journal-sql-turn-sources'
import { JournalSqlScalars } from './journal-sql-scalars'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import {
  sqlJournalInputCardFacts,
  sqlJournalInputEvidenceFacts,
  sqlJournalInputObservationFacts,
  sqlJournalInputOrderFacts,
  sqlJournalSubmissionLinkFacts,
  type JournalSqlFactsDeps
} from './journal-sql-input-facts'

function collectionName(name: string, key?: string | number): string {
  return key === undefined ? name : `${name}:${journalSqlEntryKey(key)}`
}

/** One dispatch phase's members, in insertion order, holding references to the live submissions. */
class JournalSqlSubmissionIndex implements JournalSubmissionStorage {
  constructor(
    private readonly context: JournalSqlValueContext,
    private readonly entries: JournalSqlKeyedMap<string, AgentJournalSubmission>
  ) {}

  keep(id: string, entry: AgentJournalSubmission | undefined, member: boolean): boolean {
    if (entry && member) {
      if (this.entries.get(id) === entry) {
        return false
      }
      this.entries.set(id, entry)
      return true
    }
    return this.entries.delete(id)
  }

  list(): readonly AgentJournalSubmission[] {
    return [
      ...journalSqlOrderedValues<AgentJournalSubmission>(this.context, this.entries.collection)
    ]
  }
}

export type JournalSqlIndexStorageOptions = {
  context: JournalSqlValueContext
  /** Population-sized collections with their own projection (items) and the item-range queries. */
  collections: { items?: () => JournalKeyedMap<string, AgentJournalRenderItem> }
  stateQueries: JournalStateQueries
}

/**
 * Operation-local storage for one writer command: every view reads and writes through the
 * command's SAVEPOINT and is discarded with its context. Nothing here outlives the command.
 */
export function sqlJournalIndexStorage(
  options: JournalSqlIndexStorageOptions
): JournalIndexStorageFactory {
  const { context } = options
  const indexScope = context.indexScope()
  const map = <K, V>(name: string, key?: string | number) =>
    new JournalSqlKeyedMap<K, V>(context, collectionName(name, key))
  const set = <T>(name: string, key?: string | number) =>
    new JournalSqlKeyedSet<T>(context, collectionName(name, key))
  const place = (name: string, key?: string | number) =>
    new JournalSqlPlaceIndex(indexScope, collectionName(name, key))
  const deps: JournalSqlFactsDeps = { context, map, set, place }
  return {
    stateQueries: () => options.stateQueries,
    map: <K, V>(name: string, key?: string | number): JournalKeyedMap<K, V> => {
      // Format-3 chats hold no saved queue places; only the open-time legacy decoder fills these.
      if (key === undefined && (name === 'inputEntries' || name === 'inputCards')) {
        return new Map<K, V>()
      }
      const special = key === undefined && name === 'items' ? options.collections.items : undefined
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a projection collection is registered under the reducer field name whose types it stores.
      return special ? (special() as JournalKeyedMap<K, V>) : map<K, V>(name, key)
    },
    set,
    orderFacts: () => sqlJournalInputOrderFacts(deps),
    cardFacts: () => sqlJournalInputCardFacts(deps),
    observationFacts: () => sqlJournalInputObservationFacts(deps),
    evidenceFacts: () => sqlJournalInputEvidenceFacts(deps),
    linkFacts: () => sqlJournalSubmissionLinkFacts(deps),
    place,
    queuedRows: () => new JournalSqlQueuedRows(context),
    submissions: (name) =>
      new JournalSqlSubmissionIndex(context, map<string, AgentJournalSubmission>('phase', name)),
    newestTurn: () => {
      const storage: Omit<JournalNewestTurnStorage, 'boundary'> = {
        // Sources arrive restored with the open's control export; streamed rows touch only their ids.
        initializeFromItems: false,
        sources: new JournalSqlTurnSources(indexScope),
        evidence: map('newest-turn.evidence'),
        reports: map('newest-turn.reports')
      }
      return new JournalSqlScalars(context.scope, 'newest-turn').define(storage, { boundary: 0 })
    }
  }
}
