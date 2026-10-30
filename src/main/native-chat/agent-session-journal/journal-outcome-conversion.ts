import type { JournalHostDatabase } from './journal-host-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { readJournalRowsWithin, readJournalSessionEpoch } from './journal-row-table'
import {
  journalOutcomeSource,
  publishJournalOutcomeSource,
  startJournalOutcomeGeneration
} from './journal-outcome-format'
import {
  persistJournalOutcomeRows,
  readJournalOutcomePage,
  rebuildJournalOutcomePages,
  JOURNAL_OUTCOME_PAGE_BYTES,
  JOURNAL_OUTCOME_PAGE_ROWS
} from './journal-outcome-table'
import { journalOutcomeScalars, type JournalOutcome } from './journal-outcome-codec'
import { activeJournalGenerations } from './journal-maintenance'
import {
  journalEntryJson,
  journalStateCollections,
  journalStateScalars
} from './journal-state-layout'
import type { JournalCatchUpStep, JournalCatchUpPacing } from './journal-projection-catch-up'
import type { OUTCOME_FORMAT_1_COLLECTIONS } from './journal-outcome-format-1'

// Intended: private conversion state and paced publication keep bookkeeping off the send path.
export class JournalOutcomeConversion {
  private state: JournalReducerState
  private generation = 0
  private verified = -1
  private disposed = false
  publicationMs = 0

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string
  ) {
    this.state = createJournalReducerState(sessionId, epoch)
  }

  get through(): number {
    return this.state.lastSequence
  }

  /** The first verify compares the whole staged generation with the complete input fold; later
   * ones reconcile only the outcomes staged after the verified sequence, so a chat that keeps
   * writing pays for its tail, never for the whole chat again. */
  async verify(pacing: JournalCatchUpPacing): Promise<boolean> {
    const target = this.through
    const pages =
      this.verified < 0
        ? fullVerify(this.database, this.state, this.generation)
        : tailVerify(this.database, this.state, this.generation, this.verified)
    let step = pacing.work(() => pages.next())
    while (!step.done) {
      if (
        !(await pacing.rest()) ||
        this.disposed ||
        readJournalSessionEpoch(this.database.db, this.sessionId) !== this.epoch
      ) {
        return false
      }
      step = pacing.work(() => pages.next())
    }
    if (!step.value) {
      throw new Error('converted journal outcomes differ from the complete input fold')
    }
    this.verified = target
    return true
  }

  page(): JournalCatchUpStep | 'verify' {
    const { database, sessionId, epoch } = this
    let publicationStarted: number | undefined
    const result = database.transaction(
      (db) => {
        // The catch-up checks the chat's epoch in this same synchronous step.
        if (this.disposed || journalOutcomeSource(db, sessionId, epoch)) {
          return 'retired'
        }
        if (this.generation === 0) {
          this.generation = startJournalOutcomeGeneration(db, sessionId, epoch)
          activeJournalGenerations.add(this.generation)
        }
        const newest = db
          .prepare(`SELECT MAX(generation) AS generation FROM journal_outcome_attempts
          WHERE session_id = ? AND epoch = ?`)
          .get(sessionId, epoch)
        if (newest?.generation !== this.generation) {
          return 'retired'
        }
        const stored = readJournalRowsWithin(
          db,
          sessionId,
          epoch,
          this.through,
          JOURNAL_OUTCOME_PAGE_ROWS,
          JOURNAL_OUTCOME_PAGE_BYTES
        )
        if (stored.length > 0) {
          const rows: JournalRow[] = []
          let expected = this.through + 1
          for (const entry of stored) {
            const parsed = parseJournalRow(entry.rowJson)
            if (
              !parsed.ok ||
              parsed.row.seq !== entry.seq ||
              entry.seq !== expected ||
              (expected === 1 && parsed.row.kind !== 'epoch')
            ) {
              return 'parked'
            }
            rows.push(parsed.row)
            expected += 1
          }
          const times = new Map(stored.map((entry) => [entry.seq, entry.ts]))
          const transition = persistJournalOutcomeRows(
            db,
            this.state,
            this.generation,
            rows,
            (row) => times.get(row.seq) ?? row.ts,
            true
          )
          return { adopt: transition.adopt }
        }
        if (this.through === 0) {
          return 'parked'
        }
        if (this.verified !== this.through) {
          return 'verify'
        }
        // No tail remains at the verified epoch/attempt/sequence. Publication changes metadata only.
        publicationStarted = performance.now()
        publishJournalOutcomeSource(db, sessionId, epoch, this.generation, this.through)
        return 'current'
      },
      false,
      () => {
        if (publicationStarted !== undefined) {
          this.publicationMs = performance.now() - publicationStarted
        }
      }
    )
    if (typeof result === 'object') {
      this.state = result.adopt()
      return 'advanced'
    }
    return result
  }

  close(): void {
    this.disposed = true
    activeJournalGenerations.delete(this.generation)
    this.state = createJournalReducerState(this.sessionId, this.epoch)
  }
}

function* fullVerify(
  database: JournalHostDatabase,
  state: JournalReducerState,
  generation: number
): Generator<void, boolean> {
  const rebuilt = yield* rebuildJournalOutcomePages(
    () => database.db,
    state.sessionId,
    state.epoch,
    generation,
    state.lastSequence
  )
  return yield* equalJournalStatePages(state, rebuilt)
}

/** Compaction left one staged row per key, so rows after `verified` are exactly the tail's keys:
 * each must hold the private fold's current value (or its absence). */
function* tailVerify(
  database: JournalHostDatabase,
  state: JournalReducerState,
  generation: number,
  verified: number
): Generator<void, boolean> {
  const scalars = journalOutcomeScalars(state)
  const lookups = {
    items: keyed(state.items, isText),
    itemFences: keyed(state.itemFences, isText),
    itemExecutionOwners: keyed(state.itemExecutionOwners, isText),
    providerActivityAt: keyed(state.providerActivityAt, isNumber),
    tombstones: keyed(state.tombstones, isText),
    removedTurnIds: members(state.removedTurnIds),
    submissions: keyed(state.submissions, isText),
    receipts: keyed(state.receipts, isText),
    aliases: keyed(state.aliases, isText),
    itemEchoes: keyed(state.itemEchoes, isText),
    appliedSettlementIds: members(state.appliedSettlementIds),
    stoppedHistoryCarried: keyed(state.stoppedHistoryCarried, isText),
    queuedHandOffPlaces: keyed(state.queuedHandOffPlaces, isText),
    normalizedHandOffs: members(state.normalizedHandOffs),
    'queue.cards': keyed(state.queue.cards, isText)
  } satisfies Record<(typeof OUTCOME_FORMAT_1_COLLECTIONS)[number], Lookup>
  const collections = new Map<string, Lookup>(Object.entries(lookups))
  let after = { seq: verified + 1, field: '', key: '' }
  for (;;) {
    const values = readJournalOutcomePage(database.db, generation, after, state.lastSequence)
    const last = values.at(-1)
    if (!last) {
      return true
    }
    for (const value of values) {
      if (!tailValueMatches(value, scalars, collections)) {
        return false
      }
    }
    after = { seq: last.seq, field: last.field, key: last.key }
    yield
  }
}

type Lookup = { has: (key: unknown) => boolean; get: (key: unknown) => unknown }
const isText = (key: unknown): key is string => typeof key === 'string'
const isNumber = (key: unknown): key is number => typeof key === 'number'

/** Typed point lookups into a live collection, for keys parsed from stored JSON. */
function keyed<K, V>(map: ReadonlyMap<K, V>, isKey: (key: unknown) => key is K): Lookup {
  return {
    has: (key) => isKey(key) && map.has(key),
    get: (key) => (isKey(key) ? map.get(key) : undefined)
  }
}

/** A set entry is stored as [value, value]. */
function members(set: ReadonlySet<string>): Lookup {
  return { has: (key) => isText(key) && set.has(key), get: (key) => key }
}

function tailValueMatches(
  value: JournalOutcome,
  scalars: Record<string, unknown>,
  collections: Map<string, Lookup>
): boolean {
  const key: unknown = JSON.parse(value.key)
  if (value.field === '$') {
    return typeof key === 'string' && value.json === JSON.stringify(scalars[key])
  }
  const live = collections.get(value.field)
  if (!live || value.deleted) {
    return live !== undefined && !live.has(key)
  }
  if (!live.has(key)) {
    return false
  }
  const current = live.get(key)
  return (
    value.json ===
    (value.field === 'items' ? JSON.stringify(current) : journalEntryJson(key, current))
  )
}

/** Compares insertion order and presence in byte-bounded units, excluding live Stop settlement. */
function* equalJournalStatePages(
  a: JournalReducerState,
  b: JournalReducerState
): Generator<void, boolean> {
  if (journalStateScalars(a) !== journalStateScalars(b)) {
    return false
  }
  const right = new Map(journalStateCollections(b).map((field) => [field.path, field.entries]))
  for (const field of journalStateCollections(a)) {
    const entries = right.get(field.path)?.[Symbol.iterator]()
    if (!entries) {
      return false
    }
    let bytes = 0
    let count = 0
    for (const [key, value] of field.entries) {
      const next = entries.next()
      const encoded = journalEntryJson(key, value)
      if (next.done || encoded !== journalEntryJson(next.value[0], next.value[1])) {
        return false
      }
      bytes += Buffer.byteLength(encoded)
      count += 1
      if (count >= 32 || bytes >= JOURNAL_OUTCOME_PAGE_BYTES) {
        bytes = 0
        count = 0
        yield
      }
    }
    if (!entries.next().done) {
      return false
    }
  }
  return true
}
