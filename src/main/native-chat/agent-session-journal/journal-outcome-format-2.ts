import { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import { admitOutcomeFormat1, type AdmittedOutcome } from './journal-outcome-format-1'
import {
  strictStorage,
  storageVerdict,
  type StorageDeclaresAll,
  type UndeclaredStorageKeys
} from './journal-storage-strict'

export const JOURNAL_OUTCOME_FORMAT_2 = 2
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const coordinate = z.object({ epoch: z.string().min(1), sequence: ordinal })
export const inputEntrySchema = z.object({
  context: z.object({ source: coordinate, basis: z.enum(['observed', 'legacy']), cut: ordinal }),
  witnessCardId: z.string().min(1).optional()
})
export const inputCardSchema = z.object({
  introduced: ordinal,
  baseline: z.object({ coordinate: coordinate.nullable() }).optional()
})
const entries = z.tuple([z.string().min(1), inputEntrySchema])
const cards = z.tuple([z.string().min(1), inputCardSchema])
const native = new Map<string, z.ZodType>([
  ['inputEntries', strictStorage(entries)],
  ['inputCards', strictStorage(cards)]
])

export function isNativeOutcomeField(field: string): boolean {
  return native.has(field)
}

/** Ordinary format-1 values keep their frozen meaning; format 2 adds only the native joins. */
export function admitOutcomeFormat2(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | AdmittedOutcome {
  const schema = native.get(value.field)
  if (!schema) {
    return admitOutcomeFormat1(value)
  }
  const key: unknown = JSON.parse(value.key)
  if (typeof key !== 'string' || !key) {
    throw new Error('invalid native journal key')
  }
  if (value.deleted) {
    return value.json === 'null' ? { entryKey: key, kept: null } : 'unknown'
  }
  const kept: unknown = JSON.parse(value.json)
  const verdict = storageVerdict(schema, kept)
  if (verdict === 'newer') {
    return 'unknown'
  }
  if (verdict !== 'stored' || !Array.isArray(kept) || kept[0] !== key) {
    throw new Error('invalid native journal outcome')
  }
  return { entryKey: key, kept }
}

const admittedEntry =
  z.custom<[string, JournalReducerState['inputEntries'] extends Map<string, infer V> ? V : never]>()
const admittedCard =
  z.custom<[string, JournalReducerState['inputCards'] extends Map<string, infer V> ? V : never]>()

// Admission walked the declared schema once; these views keep the exact admitted bytes' value.
export function decodeNativeOutcome(
  state: JournalReducerState,
  field: string,
  key: unknown,
  kept: unknown,
  deleted: boolean
): void {
  if (field === 'inputEntries') {
    if (deleted) {
      state.inputEntries.delete(z.string().parse(key))
    } else {
      const [id, value] = admittedEntry.parse(kept)
      state.inputEntries.set(id, value)
    }
  } else if (field === 'inputCards') {
    if (deleted) {
      state.inputCards.delete(z.string().parse(key))
    } else {
      const [id, value] = admittedCard.parse(kept)
      state.inputCards.set(id, value)
    }
  }
}

export type OutcomeFormat2DeclaresNativeKeys = [
  StorageDeclaresAll<
    UndeclaredStorageKeys<
      JournalReducerState['inputEntries'] extends Map<string, infer V> ? V : never,
      z.output<typeof inputEntrySchema>
    >
  >,
  StorageDeclaresAll<
    UndeclaredStorageKeys<
      JournalReducerState['inputCards'] extends Map<string, infer V> ? V : never,
      z.output<typeof inputCardSchema>
    >
  >
]
