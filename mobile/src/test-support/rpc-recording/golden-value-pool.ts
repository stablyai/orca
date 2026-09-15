import { createHash } from 'node:crypto'
import type { Observation, Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

type FieldShape = 'list' | 'map' | 'whole'

/**
 * How each observation field is interned. `sender`, `payloads` and `effects` are append-only
 * histories and `settlements` is keyed by action id, so every checkpoint after the first re-states
 * its predecessor's entries: pooling the whole field stored that shared prefix once per checkpoint,
 * and once per reply partition in a matrix golden. Interning per entry stores it once per file.
 *
 * Declared rather than sniffed from the value, so an empty list cannot be encoded as a map and a
 * projection that changes a field's container fails loudly instead of silently switching encodings.
 * `Record<keyof Observation, …>` makes a new observation field declare how it interns.
 */
const FIELD_SHAPES = {
  sender: 'list',
  payloads: 'list',
  settlements: 'map',
  state: 'whole',
  effects: 'list'
} as const satisfies Record<keyof Observation, FieldShape>

export const OBSERVATION_FIELDS = [
  'sender',
  'payloads',
  'settlements',
  'state',
  'effects'
] as const satisfies readonly (keyof typeof FIELD_SHAPES)[]

export type ValuePool = Record<string, RecordedValue>

type InternedField<Shape extends FieldShape> = Shape extends 'list'
  ? string[]
  : Shape extends 'map'
    ? Record<string, string>
    : string

export type InternedObservation = {
  [Field in keyof typeof FIELD_SHAPES]: InternedField<(typeof FIELD_SHAPES)[Field]>
}

export type InternedRecording = {
  scenario: string
  checkpoints: { id: string; observation: InternedObservation }[]
}

export function canonicalJson(value: RecordedValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: canonicalJson only reaches here for a plain object observation.
  const record = value as Record<string, RecordedValue>

  return `{${Object.keys(record)
    .sort()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a recorded object holds recorded values.
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as RecordedValue)}`)
    .join(',')}}`
}

export function valueHash(value: RecordedValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)
}

function listEntries(at: string, value: RecordedValue): RecordedValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Observation field ${at} is declared a list but recorded ${typeof value}`)
  }

  return value
}

function mapEntries(at: string, value: RecordedValue): [string, RecordedValue][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Observation field ${at} is declared a map but recorded ${typeof value}`)
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above rejected null and arrays, leaving a recorded object.
  return Object.entries(value as Record<string, RecordedValue>)
}

export function internRecording(recording: Recording): {
  values: ValuePool
  recording: InternedRecording
} {
  const pool: ValuePool = {}
  const canonical = new Map<string, string>()

  const intern = (entry: RecordedValue, at: string): string => {
    const hash = valueHash(entry)
    const json = canonicalJson(entry)
    const seen = canonical.get(hash)

    if (seen !== undefined && seen !== json) {
      throw new Error(`Golden value hash collision at ${hash} (${at})`)
    }

    canonical.set(hash, json)
    pool[hash] = entry

    return hash
  }

  const checkpoints = recording.checkpoints.map((checkpoint) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every declared field is assigned below before the value is read.
    const observation = {} as Record<keyof Observation, unknown>

    for (const field of OBSERVATION_FIELDS) {
      const value = checkpoint.observation[field]
      const at = `${checkpoint.id}.${field}`
      observation[field] =
        FIELD_SHAPES[field] === 'list'
          ? listEntries(at, value).map((entry, index) => intern(entry, `${at}[${index}]`))
          : FIELD_SHAPES[field] === 'map'
            ? Object.fromEntries(
                mapEntries(at, value).map(([key, entry]) => [key, intern(entry, `${at}.${key}`)])
              )
            : intern(value, at)
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each field was just encoded to the shape its declaration names.
    return { id: checkpoint.id, observation: observation as InternedObservation }
  })

  // Hash-ordered so a value's position in the pool does not move when checkpoints are reordered.
  const values = Object.fromEntries(
    Object.keys(pool)
      .sort()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pool entries are the recorded values that were interned into it.
      .map((hash) => [hash, pool[hash] as RecordedValue])
  )

  return { values, recording: { scenario: recording.scenario, checkpoints } }
}

export function resolveRecording(values: ValuePool, recording: InternedRecording): Recording {
  // Content addressing is what keeps an entry shared between checkpoints honest: editing a pooled
  // value without moving every reference to it is caught here rather than resolving silently.
  for (const [hash, value] of Object.entries(values)) {
    if (valueHash(value) !== hash) {
      throw new Error(`Golden value ${hash} does not hash to its pool key`)
    }
  }

  const referenced = new Set<string>()

  const resolve = (hash: unknown, at: string): RecordedValue => {
    if (typeof hash !== 'string' || !Object.hasOwn(values, hash)) {
      throw new Error(`Golden value ${JSON.stringify(hash)} is missing from the pool (${at})`)
    }

    referenced.add(hash)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hash was resolved against the same pool that interned it.
    return values[hash] as RecordedValue
  }

  const resolved = {
    scenario: recording.scenario,
    checkpoints: recording.checkpoints.map((checkpoint) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every declared field is assigned below before the value is read.
      const observation = {} as Observation

      for (const field of OBSERVATION_FIELDS) {
        const interned: unknown = checkpoint.observation[field]
        const at = `${checkpoint.id}.${field}`

        if (FIELD_SHAPES[field] === 'list') {
          if (!Array.isArray(interned)) {
            throw new Error(`Golden field ${at} is not a list of pool hashes`)
          }

          observation[field] = interned.map((hash, index) => resolve(hash, `${at}[${index}]`))
        } else if (FIELD_SHAPES[field] === 'map') {
          if (interned === null || typeof interned !== 'object' || Array.isArray(interned)) {
            throw new Error(`Golden field ${at} is not a map of pool hashes`)
          }

          observation[field] = Object.fromEntries(
            Object.entries(interned).map(([key, hash]) => [key, resolve(hash, `${at}.${key}`)])
          )
        } else {
          observation[field] = resolve(interned, at)
        }
      }

      return { id: checkpoint.id, observation }
    })
  }

  // An entry no checkpoint reads is content in the file that nothing compares.
  const orphans = Object.keys(values).filter((hash) => !referenced.has(hash))

  if (orphans.length) {
    throw new Error(`Golden pool holds unreferenced values: ${orphans.join(', ')}`)
  }

  return resolved
}
