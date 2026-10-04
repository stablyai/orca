import {
  canonicalJson,
  OBSERVATION_FIELDS,
  resolveRecording,
  type InternedRecording,
  type ValuePool
} from './golden-value-pool'
import type { Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

/** What a golden says about behaviour, whatever else its file format carries alongside. */
export type DecodedGolden = {
  operation: string
  family: string
  namedDeltas: string[]
  recording: Recording
}

/** One place a recording differs: a checkpoint, an observation field, and the JSON path inside it. */
export type RecordingDifference = {
  checkpoint: string
  field: string
  path: string
  expected: RecordedValue
  actual: RecordedValue
}

/** The same difference seen at several checkpoints, which an append-only history repeats. */
export type GroupedDifference = Omit<RecordingDifference, 'checkpoint'> & { checkpoints: string[] }

export const IDENTITY_FIELDS = ['operation', 'family', 'namedDeltas'] as const

/**
 * Resolves a pooled golden without judging its format version, so a diff can read both sides of a
 * format change. `readGolden` is the strict reader the recording suites use.
 */
export function decodeGoldenFile(file: unknown, id: string): DecodedGolden {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`Golden ${id} is not a JSON object`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above rejected null, arrays and primitives; each member is checked below.
  const { operation, family, namedDeltas, values, recording } = file as Record<string, unknown>
  if (typeof operation !== 'string' || typeof family !== 'string' || !Array.isArray(namedDeltas)) {
    throw new Error(`Golden ${id} is missing its operation, family or namedDeltas`)
  }
  if (!values || typeof values !== 'object' || !recording || typeof recording !== 'object') {
    throw new Error(`Golden ${id} is missing its value pool or recording`)
  }
  return {
    operation,
    family,
    namedDeltas: namedDeltas.map(String),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRecording validates every hash reference and field container it reads.
    recording: resolveRecording(values as ValuePool, recording as InternedRecording)
  }
}

export function firstDifference(
  expected: RecordedValue,
  actual: RecordedValue,
  path = ''
): { path: string; expected: RecordedValue; actual: RecordedValue } {
  const here = { path, expected, actual }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return here
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const index = expected.findIndex(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both sides are recorded observations, so every member is a RecordedValue.
      (entry, at) => canonicalJson(entry) !== canonicalJson(actual[at] as RecordedValue)
    )
    return index === -1 || index >= actual.length
      ? here
      : firstDifference(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both sides are recorded observations, so every member is a RecordedValue.
          expected[index] as RecordedValue,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both sides are recorded observations, so every member is a RecordedValue.
          actual[index] as RecordedValue,
          `${path}[${index}]`
        )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the array branch above already rejected a non-object pair.
  const left = expected as Record<string, RecordedValue>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the array branch above already rejected a non-object pair.
  const right = actual as Record<string, RecordedValue>
  const key = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().find(
    (name) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both sides are recorded observations, so every member is a RecordedValue.
      canonicalJson(left[name] as RecordedValue) !== canonicalJson(right[name] as RecordedValue)
  )
  return key === undefined || !(key in left) || !(key in right)
    ? here
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both sides are recorded observations, so every member is a RecordedValue.
      firstDifference(left[key] as RecordedValue, right[key] as RecordedValue, `${path}.${key}`)
}

export function excerpt(value: RecordedValue, limit = 600): string {
  const json = JSON.stringify(value)
  return json === undefined ? 'absent' : json.length > limit ? `${json.slice(0, limit)}…` : json
}

/**
 * Checkpoint names keyed by occurrence, because an id may repeat within one golden
 * (`tk-list-linear` records `load-settled` twice). A repeat is shown as `id#2`.
 */
function checkpointKeys(recording: Recording): string[] {
  const seen = new Map<string, number>()
  return recording.checkpoints.map((checkpoint) => {
    const occurrence = (seen.get(checkpoint.id) ?? 0) + 1
    seen.set(checkpoint.id, occurrence)
    return occurrence === 1 ? checkpoint.id : `${checkpoint.id}#${occurrence}`
  })
}

/** Checkpoints only one side records, and whether the shared ones kept their order. */
export function checkpointListDifference(
  expected: Recording,
  actual: Recording
): { missing: string[]; extra: string[]; reordered: boolean } {
  const expectedKeys = checkpointKeys(expected)
  const actualKeys = checkpointKeys(actual)
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key))
  const extra = actualKeys.filter((key) => !expectedKeys.includes(key))
  const shared = (keys: string[]) =>
    keys.filter((key) => expectedKeys.includes(key) && actualKeys.includes(key))
  return {
    missing,
    extra,
    reordered: JSON.stringify(shared(expectedKeys)) !== JSON.stringify(shared(actualKeys))
  }
}

/** Every field that differs at every checkpoint both sides record, each at its first differing path. */
export function recordingDifferences(
  expected: Recording,
  actual: Recording
): RecordingDifference[] {
  const actualKeys = checkpointKeys(actual)
  const actualByKey = new Map(
    actual.checkpoints.map((checkpoint, index) => [actualKeys[index]!, checkpoint])
  )
  const differences: RecordingDifference[] = []
  for (const [index, key] of checkpointKeys(expected).entries()) {
    const checkpoint = expected.checkpoints[index]!
    const found = actualByKey.get(key)
    if (!found) {
      continue
    }
    for (const field of OBSERVATION_FIELDS) {
      const left = checkpoint.observation[field]
      const right = found.observation[field]
      if (canonicalJson(left) === canonicalJson(right)) {
        continue
      }
      const at = firstDifference(left, right)
      differences.push({
        checkpoint: key,
        field,
        path: at.path,
        expected: at.expected,
        actual: at.actual
      })
    }
  }
  return differences
}

/** Why grouped: a moved early entry re-appears in every later checkpoint of an append-only field. */
export function groupDifferences(differences: RecordingDifference[]): GroupedDifference[] {
  const groups = new Map<string, GroupedDifference>()
  for (const difference of differences) {
    const key = [
      difference.field,
      difference.path,
      canonicalJson(difference.expected),
      canonicalJson(difference.actual)
    ].join('\0')
    const group = groups.get(key)
    if (group) {
      group.checkpoints.push(difference.checkpoint)
    } else {
      const { checkpoint, ...rest } = difference
      groups.set(key, { ...rest, checkpoints: [checkpoint] })
    }
  }
  return [...groups.values()]
}

/** A golden's identity fields that differ, named so a failure says which one moved. */
export function identityDifferences(
  expected: DecodedGolden,
  actual: DecodedGolden
): { field: (typeof IDENTITY_FIELDS)[number]; expected: unknown; actual: unknown }[] {
  return IDENTITY_FIELDS.flatMap((field) =>
    JSON.stringify(expected[field]) === JSON.stringify(actual[field])
      ? []
      : [{ field, expected: expected[field], actual: actual[field] }]
  )
}
