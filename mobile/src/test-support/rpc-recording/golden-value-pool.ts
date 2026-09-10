import { createHash } from 'node:crypto'
import type { Observation, Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

export const OBSERVATION_FIELDS = [
  'sender',
  'payloads',
  'settlements',
  'state',
  'effects'
] as const satisfies readonly (keyof Observation)[]

export type ValuePool = Record<string, RecordedValue>
export type InternedObservation = Record<keyof Observation, string>
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
  const record = value as Record<string, RecordedValue>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as RecordedValue)}`)
    .join(',')}}`
}

export function valueHash(value: RecordedValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 12)
}

export function internRecording(recording: Recording): {
  values: ValuePool
  recording: InternedRecording
} {
  const pool: ValuePool = {}
  const canonical = new Map<string, string>()
  const checkpoints = recording.checkpoints.map((checkpoint) => {
    const observation = {} as InternedObservation
    for (const field of OBSERVATION_FIELDS) {
      const value = checkpoint.observation[field]
      const json = canonicalJson(value)
      const hash = valueHash(value)
      const seen = canonical.get(hash)
      if (seen !== undefined && seen !== json) {
        throw new Error(`Golden value hash collision at ${hash} (${checkpoint.id}.${field})`)
      }
      canonical.set(hash, json)
      pool[hash] = value
      observation[field] = hash
    }
    return { id: checkpoint.id, observation }
  })
  // Hash-ordered so a value's position in the pool does not move when checkpoints are reordered.
  const values = Object.fromEntries(
    Object.keys(pool)
      .sort()
      .map((hash) => [hash, pool[hash] as RecordedValue])
  )
  return { values, recording: { scenario: recording.scenario, checkpoints } }
}

export function resolveRecording(values: ValuePool, recording: InternedRecording): Recording {
  return {
    scenario: recording.scenario,
    checkpoints: recording.checkpoints.map((checkpoint) => {
      const observation = {} as Observation
      for (const field of OBSERVATION_FIELDS) {
        const hash = checkpoint.observation[field]
        if (!(hash in values)) {
          throw new Error(
            `Golden value ${hash} is missing from the pool (${checkpoint.id}.${field})`
          )
        }
        observation[field] = values[hash] as RecordedValue
      }
      return { id: checkpoint.id, observation }
    })
  }
}
