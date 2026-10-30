import { z } from 'zod'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalReducerState } from './journal-reducer'
import type { JournalEntryChange } from './journal-transition-collections'
import { fields, scalarsV2 } from './journal-state-schema'
import { journalEntryJson, journalStateScalars } from './journal-state-layout'
import { JOURNAL_STATE_CODEC_VERSION, startJournalStateDecode } from './journal-state-codec'

export type JournalOutcome = {
  seq: number; field: string; key: string; ordinal: string; json: string; deleted: boolean
}
const scalarSchemas = new Map<string, z.ZodType>(Object.entries(scalarsV2.shape))
const collectionSchemas = new Map<string, z.ZodType>([
  ...Object.entries(fields).filter(([, schema]) => schema instanceof z.ZodArray),
  ['queue.cards', fields.queue.shape.cards]
])
const scalars = (state: JournalReducerState): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(journalStateScalars(state)))

/** Encoding freezes a sequence's contributions before the next input can mutate the draft. */
export function encodeJournalOutcomes(
  state: JournalReducerState,
  changes: readonly JournalEntryChange[],
  before: Record<string, unknown>
): { values: Omit<JournalOutcome, 'ordinal'>[]; scalars: Record<string, unknown> } {
  const next = scalars(state)
  const values = changes.map((entry) => ({
    seq: state.lastSequence, field: entry.path, key: JSON.stringify(entry.key),
    json: entry.deleted ? 'null' : entry.path === 'items'
      ? JSON.stringify(entry.value) : journalEntryJson(entry.key, entry.value),
    deleted: entry.deleted
  }))
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(before[key])) {
      values.push({ seq: state.lastSequence, field: '$', key: JSON.stringify(key),
        json: JSON.stringify(value), deleted: false })
    }
  }
  for (const value of values) {
    validateOutcome(value)
  }
  return { values, scalars: next }
}

export function journalOutcomeScalars(state: JournalReducerState): Record<string, unknown> {
  return scalars(state)
}

export function decodeJournalOutcome(row: SqliteRow): JournalOutcome {
  if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1 ||
    typeof row.field !== 'string' || typeof row.entry_key !== 'string' ||
    typeof row.ordinal !== 'string' || !/^s\d{16}:\d{16}$/.test(row.ordinal) ||
    typeof row.value_json !== 'string' || (row.deleted !== 0 && row.deleted !== 1)) {
    throw new Error('invalid journal outcome')
  }
  const value = { seq: row.seq, field: row.field, key: row.entry_key,
    ordinal: row.ordinal, json: row.value_json, deleted: row.deleted === 1 }
  validateOutcome(value)
  return value
}

function validateOutcome(value: Omit<JournalOutcome, 'ordinal'>): void {
  const key: unknown = JSON.parse(value.key)
  if (value.field === '$') {
    const schema = typeof key === 'string' ? scalarSchemas.get(key) : undefined
    if (!schema || value.deleted) {
      throw new Error('invalid journal scalar outcome')
    }
    schema.parse(JSON.parse(value.json))
    return
  }
  const schema = collectionSchemas.get(value.field)
  if (!schema || (typeof key !== 'string' && typeof key !== 'number')) {
    throw new Error('invalid journal collection outcome')
  }
  if (!value.deleted) {
    const decoded: unknown = JSON.parse(value.json)
    if (value.field === 'items') {
      const item = fields.items.element.parse(decoded)
      if (item.itemId !== key) {
        throw new Error('mismatched journal item outcome')
      }
    } else if (value.field === 'itemEchoes') {
      const echo = fields.itemEchoes.element.parse(decoded)
      if (JSON.stringify(echo[0]) !== value.key) {
        throw new Error('mismatched journal echo outcome')
      }
    } else {
      const tuple = z.array(z.unknown()).parse(decoded)
      const set = ['removedTurnIds', 'appliedSettlementIds', 'normalizedHandOffs'].includes(value.field)
      schema.parse([set ? tuple[0] : tuple])
      if (JSON.stringify(tuple[0]) !== value.key) {
        throw new Error('mismatched journal keyed outcome')
      }
    }
  }
}

/** Last-write-wins stores only whole current values; order comes from the canonical log. */
export class JournalOutcomeFold {
  private readonly values = new Map<string, Map<string, JournalOutcome>>()
  add(value: JournalOutcome): void {
    let field = this.values.get(value.field)
    if (!field) {
      field = new Map()
      this.values.set(value.field, field)
    }
    if (value.deleted) {
      field.delete(value.key)
    } else {
      field.set(value.key, value)
    }
  }
  *finishPages(sessionId: string, epoch: string, through: number): Generator<void, JournalReducerState> {
    const scalar = Object.fromEntries([...(this.values.get('$')?.values() ?? [])]
      .map((value) => [JSON.parse(value.key), JSON.parse(value.json)]))
    const decode = startJournalStateDecode(JOURNAL_STATE_CODEC_VERSION, JSON.stringify(scalar))
    if (!decode) {
      throw new Error('unsupported journal outcome state')
    }
    let bytes = 0
    let count = 0
    for (const [field, entries] of this.values) {
      if (field === '$') {
        continue
      }
      const ordered = [...entries.values()].sort((a, b) => a.ordinal.localeCompare(b.ordinal))
      for (const value of ordered) {
        if (field === 'items') {
          decode.item(value.json)
        } else {
          decode.entry(field, value.json)
        }
        bytes += Buffer.byteLength(value.json)
        count += 1
        if (count >= 32 || bytes >= 1 << 20) {
          bytes = 0
          count = 0
          yield
        }
      }
    }
    const state = decode.finish()
    if (state.sessionId !== sessionId || state.epoch !== epoch || state.lastSequence !== through) {
      throw new Error('invalid journal outcome coverage')
    }
    return state
  }
}
