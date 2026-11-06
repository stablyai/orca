import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { JournalInputPlaceIndex } from './journal-input-place-index'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputReleasedPositions } from './journal-input-released-positions'
import { JournalInputCandidates } from './journal-input-candidates'
import { JournalSubmissionIndex } from './journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'
import { memoryJournalMap } from './journal-memory-collections'

/** Restored fields the export leaves alone: item content keeps its own projection, and query
 *  procedures and back-references are the reducer's wiring, not saved facts. */
const WIRING = ['queries', 'state', 'keyReads']

/** The SQL storage at the same place as a memory container: whichever of these its kind has. */
type Importer = {
  importEntry: (...args: unknown[]) => void
  importState: (state: unknown) => void
  set: (...args: unknown[]) => unknown
  add: (value: unknown) => unknown
  get: (key: unknown) => unknown
  keep: (...args: unknown[]) => unknown
}

function isImporter(value: unknown): value is Importer {
  return typeof value === 'object' && value !== null
}

/**
 * Copies an actual open's restored control facts into a SQL reducer over an empty epoch.
 * Both graphs are built by the same reducer classes over different storage, so they pair field by
 * field; each memory index hands its entries to the SQL index of the same place, and every value
 * goes through one value context, so an object two collections share stays shared.
 */
export function exportJournalControlState(
  memory: JournalReducerState,
  sql: JournalReducerState,
  options: { items: boolean }
): void {
  if (options.items) {
    for (const [key, item] of memoryJournalMap(memory.items)) {
      sql.items.set(key, item)
    }
  }
  for (const [key, send] of memoryJournalMap(memory.submissions)) {
    sql.submissions.set(key, send)
  }
  for (const [key, receipt] of memoryJournalMap(memory.receipts)) {
    sql.receipts.set(key, receipt)
  }
  for (const [key, card] of memoryJournalMap(memory.queue.cards)) {
    sql.queue.cards.set(key, card)
  }
  for (const [key, entry] of memoryJournalMap(memory.inputEntries)) {
    sql.inputEntries.set(key, entry)
  }
  for (const [key, card] of memoryJournalMap(memory.inputCards)) {
    sql.inputCards.set(key, card)
  }
  for (const [key, source] of memoryJournalMap(memory.inputs.sources)) {
    sql.inputs.sources.set(key, source)
  }
  for (const { path, value, container } of journalControlStateEntries(memory)) {
    if (
      [
        'state.items',
        'state.submissions',
        'state.receipts',
        'state.queue.cards',
        'state.inputEntries',
        'state.inputCards',
        'state.inputs.sources'
      ].includes(path.join('.'))
    ) {
      continue
    }
    let target: object = path[0] === 'state' ? sql : journalInputOrder(sql)
    for (const key of path.slice(1, -1)) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- The paired reducer graph is selected by its declared field path.
      const next: unknown = Reflect.get(target, key)
      if (!isImporter(next)) {
        throw new Error('Missing journal export target')
      }
      target = next
    }
    const key = path.at(-1)!
    if (container) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- A container's matching SQL handle owns the import procedure.
      copyContainer(value, Reflect.get(target, key), path.join('.'))
    } else {
      Reflect.set(target, key, value)
    }
  }
}

export type JournalControlStateEntry = {
  path: string[]
} & ({ container: true; value: object } | { container: false; value: unknown })

/** Enumerates the same restored facts for SQL imports and direct record encoding. */
export function* journalControlStateEntries(
  memory: JournalReducerState
): Generator<JournalControlStateEntry> {
  const seen = new Set<object>()
  yield* fields(memory, seen, ['state'])
  yield* fields(journalInputOrder(memory), seen, ['order'])
}

function* fields(
  memory: object,
  seen: Set<object>,
  path: string[]
): Generator<JournalControlStateEntry> {
  if (seen.has(memory)) {
    return
  }
  seen.add(memory)
  for (const [key, value] of Object.entries(memory)) {
    if (WIRING.includes(key) || typeof value === 'function') {
      continue
    }
    if (isContainer(value)) {
      if (!seen.has(value)) {
        seen.add(value)
        yield { path: [...path, key], value, container: true }
      }
    } else if (isStructural(value)) {
      yield* fields(value, seen, [...path, key])
    } else {
      yield { path: [...path, key], value, container: false }
    }
  }
}

function copyContainer(memory: object, sql: unknown, path: string): void {
  if (!isImporter(sql)) {
    throw new Error(`journal control export found no SQL storage at ${path}`)
  }
  if (memory instanceof Map) {
    for (const [key, value] of memory) {
      sql.set(key, value)
      if (isContainer(value)) {
        // A nested index is a handle the SQL side reopens by key once its membership exists.
        copyContainer(value, sql.get(key), `${path}[${String(key)}]`)
      }
    }
  } else if (memory instanceof Set) {
    for (const value of memory) {
      sql.add(value)
    }
  } else if (memory instanceof JournalInputPlaceIndex) {
    for (const entry of memory.exportEntries()) {
      sql.importEntry(entry)
    }
  } else if (memory instanceof JournalInputDomainIndex) {
    for (const { introduced, entry } of memory.exportEntries()) {
      sql.importEntry(introduced, entry)
    }
  } else if (memory instanceof JournalInputReleasedPositions) {
    sql.importState(memory.exportState())
  } else if (memory instanceof JournalInputCandidates) {
    for (const card of memory.exportCards()) {
      sql.set(card, true)
    }
  } else if (memory instanceof JournalSubmissionIndex) {
    for (const [id, entry] of memory.exportEntries()) {
      sql.keep(id, entry, true)
    }
  } else if (memory instanceof MemoryJournalTurnSources) {
    for (const [id, source] of memory.exportSources()) {
      sql.set(id, source)
    }
  }
}

function isContainer(value: unknown): value is object {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof JournalInputPlaceIndex ||
    value instanceof JournalInputDomainIndex ||
    value instanceof JournalInputReleasedPositions ||
    value instanceof JournalInputCandidates ||
    value instanceof JournalSubmissionIndex ||
    value instanceof MemoryJournalTurnSources
  )
}

/** Objects that hold storage are walked; plain saved values are assigned whole. */
function isStructural(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return true
  }
  return Object.values(value).some(
    (field) => isContainer(field) || typeof field === 'function' || isStructural(field)
  )
}
