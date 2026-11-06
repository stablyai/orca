import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { JournalInputPlaceIndex } from './journal-input-place-index'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputReleasedPositions } from './journal-input-released-positions'
import { JournalInputCandidates } from './journal-input-candidates'
import { JournalSubmissionIndex } from './journal-submission-index'
import { MemoryJournalTurnSources } from './journal-memory-turn-sources'

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
 * Copies an actual open's restored control facts into a SQL reducer over an empty generation.
 * Both graphs are built by the same reducer classes over different storage, so they pair field by
 * field; each memory index hands its entries to the SQL index of the same place, and every value
 * goes through one value context, so an object two collections share stays shared.
 */
export function exportJournalControlState(
  memory: JournalReducerState,
  sql: JournalReducerState,
  options: { items: boolean }
): void {
  const seen = new Set<object>()
  const skipped = new Set(options.items ? WIRING : [...WIRING, 'items'])
  copyFields(memory, sql, { seen, skipped }, 'state')
  copyFields(journalInputOrder(memory), journalInputOrder(sql), { seen, skipped }, 'order')
}

type Walk = { seen: Set<object>; skipped: ReadonlySet<string> }

function copyFields(memory: object, sql: object, walk: Walk, path: string): void {
  const { seen } = walk
  if (seen.has(memory)) {
    return
  }
  seen.add(memory)
  for (const [key, value] of Object.entries(memory)) {
    if (walk.skipped.has(key) || typeof value === 'function') {
      continue
    }
    const target: unknown = Reflect.get(sql, key)
    if (isContainer(value)) {
      if (!seen.has(value)) {
        seen.add(value)
        copyContainer(value, target, `${path}.${key}`)
      }
    } else if (isStructural(value) && isImporter(target)) {
      copyFields(value, target, walk, `${path}.${key}`)
    } else {
      Reflect.set(sql, key, value)
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
