import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type {
  JournalInputOrderFacts,
  JournalInputCardFacts,
  JournalInputObservationFacts,
  JournalInputEvidenceFacts,
  JournalSubmissionLinkFacts,
  JournalInputLineageFacts
} from './journal-input-facts-storage'
import type { JournalInputPlaceStorage } from './journal-index-storage'
import type { JournalInputCard } from './input-order/journal-input-lineage'
import type { JournalKeyedMap, JournalKeyedSet } from './journal-keyed-storage'
import {
  JournalSqlKeyedMap,
  journalSqlOrderedKeys,
  journalSqlOrderedValues,
  type JournalSqlKeyedSet
} from './journal-sql-keyed-values'
import { JournalSqlScalars } from './journal-sql-scalars'
import { journalSqlPauseKey } from './journal-sql-pause-marks'
import type { JournalSqlValueContext } from './journal-sql-value-context'

export type JournalSqlFactsDeps = {
  context: JournalSqlValueContext
  map: <K, V>(name: string, key?: string | number) => JournalSqlKeyedMap<K, V>
  set: <T>(name: string, key?: string | number) => JournalSqlKeyedSet<T>
  place: (name: string, key?: string | number) => JournalInputPlaceStorage
}

/**
 * Nested indexes keyed by one fact (provider item, fence, family) exist while non-empty. Storage is
 * a membership row; a read rebuilds the handle, so no SQL view or connection is ever serialized.
 */
class JournalSqlHandleMap<K extends string | number, H> implements JournalKeyedMap<K, H> {
  private readonly members: JournalSqlKeyedSet<K>
  constructor(
    deps: JournalSqlFactsDeps,
    name: string,
    private readonly open: (key: K) => H
  ) {
    this.members = deps.set<K>(`@handles:${name}`)
  }
  get size(): number {
    return this.members.size
  }
  get(key: K): H | undefined {
    return this.members.has(key) ? this.open(key) : undefined
  }
  has(key: K): boolean {
    return this.members.has(key)
  }
  set(key: K, _handle: H): this {
    this.members.add(key)
    return this
  }
  delete(key: K): boolean {
    return this.members.delete(key)
  }
  clear(): void {
    this.members.clear()
  }
}

function first<T>(values: Iterable<T>): T | undefined {
  for (const value of values) {
    return value
  }
  return undefined
}

function* orderedEntries<K, V>(
  context: JournalSqlValueContext,
  collection: string
): Generator<[K, V]> {
  for (const key of journalSqlOrderedKeys(context, collection)) {
    yield [JSON.parse(key), context.read<V>(collection, key)!]
  }
}

export function sqlJournalInputOrderFacts(deps: JournalSqlFactsDeps): JournalInputOrderFacts {
  const { context } = deps
  const queued = deps.map<string, AgentJournalSubmission>('order.queued')
  const entered = deps.map<string, AgentJournalSubmission>('order.entered')
  const overrides = deps.map<string, AgentJournalSubmission>('order.overrides')
  const recoveryOwed = deps.set<string>('order.recoveryOwed')
  const facts: Omit<
    JournalInputOrderFacts,
    'reconstructing' | 'receiptCount' | 'queueRevision' | 'revision'
  > = {
    recoveryOwed,
    queued,
    entered,
    overrides,
    firstQueued: () =>
      first(journalSqlOrderedValues<AgentJournalSubmission>(context, queued.collection, 1)),
    explicitSend: () =>
      first(journalSqlOrderedValues<AgentJournalSubmission>(context, overrides.collection, 1)),
    // Entered sends are the outstanding handovers of live executions, not history.
    enteredSubmissions: () =>
      journalSqlOrderedValues<AgentJournalSubmission>(context, entered.collection),
    recoveryOwedIds: () => journalSqlOrderedValues<string>(context, recoveryOwed.collection)
  }
  const scalars: Pick<
    JournalInputOrderFacts,
    'reconstructing' | 'receiptCount' | 'queueRevision' | 'revision'
  > = { reconstructing: false, receiptCount: 0, queueRevision: 0, revision: 0 }
  return new JournalSqlScalars(context.scope, 'order').define(facts, scalars)
}

export function sqlJournalInputCardFacts(deps: JournalSqlFactsDeps): JournalInputCardFacts {
  const { context } = deps
  const cells = new JournalSqlScalars(context.scope, 'cards')
  const current = deps.map<string, QueuedMessageRow>('cards.current')
  const overlays = deps.map<string, QueuedMessageRow>('cards.overlays')
  const unintroduced = deps.set<string>('cards.unintroduced')
  const cleared = deps.set<string>('cards.cleared')
  // Overlay rows are compared by identity on the same handle; a new command never holds them.
  let overlayRows: readonly QueuedMessageRow[] = []
  const facts: Omit<
    JournalInputCardFacts,
    'currentRevision' | 'initialized' | 'floor' | 'pauses' | 'failed'
  > = {
    current,
    indexed: deps.map('cards.indexed'),
    unintroduced,
    overlays,
    cleared,
    currentCards: () => journalSqlOrderedValues<QueuedMessageRow>(context, current.collection),
    overlayCards: () => journalSqlOrderedValues<QueuedMessageRow>(context, overlays.collection),
    unintroducedIds: () => journalSqlOrderedValues<string>(context, unintroduced.collection),
    replaceOverlays(cards: Map<string, QueuedMessageRow>) {
      overlays.clear()
      for (const [id, card] of cards) {
        overlays.set(id, card)
      }
    },
    replaceClearMembers(ids: readonly string[]) {
      cleared.clear()
      for (const id of ids) {
        cleared.add(id)
      }
    },
    get overlayRows() {
      return overlayRows
    },
    set overlayRows(rows: readonly QueuedMessageRow[]) {
      overlayRows = rows
    },
    get pauseKey() {
      return cells.get<readonly unknown[]>('pauseKey', [])
    },
    set pauseKey(inputs: readonly unknown[]) {
      cells.set('pauseKey', inputs.map(journalSqlPauseKey))
    },
    pauseKeyMatches(this: Pick<JournalInputCardFacts, 'pauseKey'>, inputs: readonly unknown[]) {
      return JSON.stringify(inputs.map(journalSqlPauseKey)) === JSON.stringify(this.pauseKey)
    }
  }
  const scalars: Pick<
    JournalInputCardFacts,
    'currentRevision' | 'initialized' | 'floor' | 'pauses' | 'failed'
  > = {
    currentRevision: 0,
    initialized: false,
    floor: null,
    pauses: [],
    failed: false
  }
  return cells.define(facts, scalars)
}

export function sqlJournalInputObservationFacts(
  deps: JournalSqlFactsDeps
): JournalInputObservationFacts {
  const recoveredUnknown = deps.set<string>('observations.recoveredUnknown')
  return {
    providerInputs: new JournalSqlHandleMap(deps, 'provider-inputs', (key: string) =>
      deps.place('provider-inputs', key)
    ),
    providerByInput: deps.map('observations.providerByInput'),
    inputIds: deps.map('observations.inputIds'),
    dispatchByFence: new JournalSqlHandleMap(deps, 'dispatch-by-fence', (key: number) =>
      deps.place('dispatch-by-fence', key)
    ),
    signedOutByFence: new JournalSqlHandleMap<number, JournalKeyedSet<string>>(
      deps,
      'signed-out-members',
      (key) => deps.set<string>('signed-out-members', key)
    ),
    fences: deps.map('observations.fences'),
    recoveredUnknown,
    recoveredUnknownIds: () =>
      journalSqlOrderedValues<string>(deps.context, recoveredUnknown.collection)
  }
}

export function sqlJournalInputEvidenceFacts(deps: JournalSqlFactsDeps): JournalInputEvidenceFacts {
  const { context } = deps
  const recoverable = deps.map<string, AgentJournalSubmission>('evidence.recoverable')
  const statusPending = deps.map<string, AgentJournalSubmission>('evidence.statusPending')
  const facts: Omit<JournalInputEvidenceFacts, 'nextOrdinal'> = {
    recoverable,
    submissionRows: deps.map('evidence.submissionRows'),
    rowsBySubmission: deps.map('evidence.rowsBySubmission'),
    keptCards: new JournalSqlHandleMap<string, JournalKeyedSet<string>>(
      deps,
      'kept-card-members',
      (key) => deps.set<string>('kept-card-members', key)
    ),
    keptBySubmission: deps.map('evidence.keptBySubmission'),
    ordinals: deps.map('evidence.ordinals'),
    statusPending,
    steers: new JournalSqlHandleMap(deps, 'steers', (key: string) => deps.place('steers', key)),
    steerTurns: deps.map('evidence.steerTurns'),
    stoppedCandidates: deps.set('evidence.stoppedCandidates'),
    carrierCoverage: deps.map('evidence.carrierCoverage'),
    coveredBy: new JournalSqlHandleMap<string, JournalKeyedSet<string>>(
      deps,
      'carrier-coverers',
      (key) => deps.set<string>('carrier-coverers', key)
    ),
    recoverableSubmissions: () =>
      journalSqlOrderedValues<AgentJournalSubmission>(context, recoverable.collection),
    statusPendingIds: () =>
      (function* () {
        for (const key of journalSqlOrderedKeys(context, statusPending.collection)) {
          yield String(JSON.parse(key))
        }
      })()
  }
  const scalars: Pick<JournalInputEvidenceFacts, 'nextOrdinal'> = { nextOrdinal: 0 }
  return new JournalSqlScalars(context.scope, 'evidence').define(facts, scalars)
}

export function sqlJournalSubmissionLinkFacts(
  deps: JournalSqlFactsDeps
): JournalSubmissionLinkFacts {
  const { context } = deps
  const family = (key: string) => deps.map<string, AgentJournalSubmission>('link-family', key)
  const facts: Omit<JournalSubmissionLinkFacts, 'revision' | 'acceptedHandoverAt'> = {
    linked: new JournalSqlHandleMap<string, JournalKeyedMap<string, AgentJournalSubmission>>(
      deps,
      'link-family',
      family
    ),
    ids: deps.map('links.ids'),
    latest: deps.map('links.latest'),
    // A family is the attempts of one queued message.
    familyMembers: (key: string) =>
      journalSqlOrderedValues<AgentJournalSubmission>(context, family(key).collection),
    familyMemberIds: (key: string) =>
      (function* () {
        for (const [id] of orderedEntries<string, unknown>(context, family(key).collection)) {
          yield id
        }
      })()
  }
  const scalars: Pick<JournalSubmissionLinkFacts, 'revision' | 'acceptedHandoverAt'> = {
    revision: 0,
    acceptedHandoverAt: 0
  }
  return new JournalSqlScalars(context.scope, 'links').define(facts, scalars)
}

function sqlCollection<K, V>(map: JournalKeyedMap<K, V>): string {
  if (!(map instanceof JournalSqlKeyedMap)) {
    throw new Error('SQL lineage facts read only SQL keyed collections')
  }
  return map.collection
}

export function sqlJournalInputLineageFacts(
  deps: JournalSqlFactsDeps,
  cards: JournalKeyedMap<string, JournalInputCard>
): JournalInputLineageFacts {
  const { context } = deps
  const facts: Omit<JournalInputLineageFacts, 'base' | 'clock'> = {
    cards,
    // Callers: epoch publish over its new epoch's rows; actual opens restore in memory.
    frontier() {
      context.flush()
      const { scope } = context
      const entry = scope.db
        .prepare(`SELECT MAX(cut) AS frontier FROM journal_proj_input_entries
          WHERE session_id=? AND epoch=? AND current=1`)
        .get(...scope.prefix)!
      const card = scope.db
        .prepare(`SELECT MAX(introduced) AS frontier FROM journal_proj_lineage_cards
          WHERE session_id=? AND epoch=? AND current=1`)
        .get(...scope.prefix)!
      scope.examined(entry)
      scope.examined(card)
      return Math.max(Number(entry.frontier ?? 0), Number(card.frontier ?? 0))
    },
    // Reconstruction releases finished cards and retains current introductions.
    cardsForRelease: () => orderedEntries<string, JournalInputCard>(context, sqlCollection(cards))
  }
  const scalars: Pick<JournalInputLineageFacts, 'base' | 'clock'> = { base: 0, clock: 0 }
  return new JournalSqlScalars(context.scope, 'lineage').define(facts, scalars)
}
