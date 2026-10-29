import {
  canonicalJson,
  OBSERVATION_FIELDS,
  resolveRecording,
  type InternedRecording,
  type ValuePool
} from './golden-value-pool'
import type { Recording } from './recording-scenario'
import type { RecordedValue } from './recording-values'

export type DecodedGolden = {
  operation: string
  family: string
  namedDeltas: string[]
  recording: Recording
}

export type RecordingDifference = {
  checkpoint: string
  field: string
  path: string
  expected: RecordedValue
  actual: RecordedValue
  expectedPresent?: boolean
  actualPresent?: boolean
}

export type GroupedDifference = Omit<RecordingDifference, 'checkpoint'> & { checkpoints: string[] }

export const IDENTITY_FIELDS = ['operation', 'family', 'namedDeltas'] as const

// Ignore format version for diffs across format changes; recording suites use the strict readGolden reader.
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

// Key repeated checkpoint ids by occurrence so later instances remain distinguishable.
export function checkpointKeys(recording: Recording): string[] {
  const seen = new Map<string, number>()
  return recording.checkpoints.map((checkpoint) => {
    const occurrence = (seen.get(checkpoint.id) ?? 0) + 1
    seen.set(checkpoint.id, occurrence)
    return occurrence === 1 ? checkpoint.id : `${checkpoint.id}#${occurrence}`
  })
}

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

// Preserve absent members and array lengths as separate difference evidence.
export function valueDifferences(
  expected: RecordedValue,
  actual: RecordedValue,
  path = ''
): Omit<RecordingDifference, 'checkpoint' | 'field'>[] {
  if (expected === actual) {
    return []
  }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    return [{ path, expected, actual }]
  }
  const differences: Omit<RecordingDifference, 'checkpoint' | 'field'>[] = []
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length) {
    differences.push({ path: `${path}.length`, expected: expected.length, actual: actual.length })
  }
  const left = new Map(Object.entries(expected))
  const right = new Map(Object.entries(actual))
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const next = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`
    const mine = left.get(key)
    const theirs = right.get(key)
    if (!left.has(key) || !right.has(key)) {
      differences.push({
        path: next,
        expected: left.has(key) ? mine! : { $rpc: 'absent' },
        actual: right.has(key) ? theirs! : { $rpc: 'absent' },
        expectedPresent: left.has(key),
        actualPresent: right.has(key)
      })
    } else {
      differences.push(...valueDifferences(mine!, theirs!, next))
    }
  }
  return differences
}

// Align shared checkpoints by identity and occurrence even when lists differ.
export function recordingDifferences(
  expected: Recording,
  actual: Recording,
  complete = false
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
      if (!complete && canonicalJson(left) === canonicalJson(right)) {
        continue
      }
      for (const at of complete ? valueDifferences(left, right) : [firstDifference(left, right)]) {
        differences.push({ checkpoint: key, field, ...at })
      }
    }
  }
  return differences
}

// Group repeated differences from append-only histories across checkpoints.
export function groupDifferences(differences: RecordingDifference[]): GroupedDifference[] {
  const groups = new Map<string, GroupedDifference>()
  for (const difference of differences) {
    const key = [
      difference.field,
      difference.path,
      canonicalJson(difference.expected),
      canonicalJson(difference.actual),
      difference.expectedPresent,
      difference.actualPresent
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
