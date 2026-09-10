import { format } from 'oxfmt'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalJson,
  internRecording,
  OBSERVATION_FIELDS,
  resolveRecording,
  type InternedRecording,
  type ValuePool
} from './golden-value-pool'
import { recorderSha256 } from './recorder-digest'
import type { Recording, RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

export const RUNNER_VERSION = 1
// 2 stamps every settlement with startedAt/settledAt on the pinned virtual clock.
export const PROJECTION_VERSION = 2
// 2 interns observation field values into a pooled map; a version 1 file is not comparable here.
export const GOLDEN_FORMAT_VERSION = 2
export type GoldenRecording = {
  operation: string
  family: string
  namedDeltas: string[]
  runnerVersion: number
  baseline: string
  lockfileSha256: string
  recorderSha256: string
  platform: string
  scenarioVersion: number
  projectionVersion: number
  goldenFormatVersion: number
  recording: Recording
}
type GoldenFile = Omit<GoldenRecording, 'recording'> & {
  values: ValuePool
  recording: InternedRecording
}
export function goldenRecording(
  root: string,
  baseline: string,
  scenario: RecordingScenario,
  recording: Recording
): GoldenRecording {
  return {
    operation: scenario.operation,
    family: scenario.family,
    namedDeltas: scenario.namedDeltas ?? [],
    runnerVersion: RUNNER_VERSION,
    baseline,
    lockfileSha256: createHash('sha256')
      .update(readFileSync(join(root, 'mobile/pnpm-lock.yaml')))
      .digest('hex'),
    recorderSha256: recorderSha256(root),
    platform: process.platform,
    scenarioVersion: scenario.version,
    projectionVersion: PROJECTION_VERSION,
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    recording
  }
}
export function goldenBytes(golden: GoldenRecording): string {
  const { recording: _value, ...header } = golden
  const interned = internRecording(golden.recording)
  return `${JSON.stringify({ ...header, values: interned.values, recording: interned.recording }, null, 2)}\n`
}
export function readGolden(directory: string, id: string): GoldenRecording {
  const file = JSON.parse(readFileSync(goldenPath(directory, id), 'utf8')) as Partial<GoldenFile>
  if (file.goldenFormatVersion !== GOLDEN_FORMAT_VERSION) {
    throw new Error(
      `Golden ${id} has format version ${JSON.stringify(file.goldenFormatVersion)}; this reader requires ${GOLDEN_FORMAT_VERSION}. Re-record with --record.`
    )
  }
  if (!file.values || !file.recording) {
    throw new Error(`Golden ${id} is missing its value pool or recording`)
  }
  const { values: _pool, ...header } = file as GoldenFile
  return { ...header, recording: resolveRecording(file.values, file.recording) }
}
export async function writeGolden(
  directory: string,
  golden: GoldenRecording,
  mode: string
): Promise<void> {
  if (mode !== '--record' || process.env.RPC_FOUNDATION_RECORD !== '1') {
    throw new Error('Golden writes require --record and RPC_FOUNDATION_RECORD=1')
  }
  mkdirSync(directory, { recursive: true })
  const path = goldenPath(directory, golden.recording.scenario)
  const result = await format(path, goldenBytes(golden), { printWidth: 100, trailingComma: 'none' })
  if (result.errors.length) {
    throw new Error('Cannot format golden')
  }
  writeFileSync(path, result.code)
}
function goldenPath(directory: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error(`Unsafe scenario id: ${id}`)
  }
  return join(directory, `${id}.json`)
}
export function compareGolden(expected: GoldenRecording, actual: GoldenRecording): void {
  const scenario = actual.recording.scenario
  // Platform is provenance; cross-platform candidates still compare the complete behavioral trace.
  const pinned = { ...expected, platform: actual.platform }
  const { recording: _expectedRecording, ...expectedHeader } = pinned
  const { recording: _actualRecording, ...actualHeader } = actual
  for (const [key, value] of Object.entries(expectedHeader)) {
    const found = (actualHeader as Record<string, unknown>)[key]
    if (JSON.stringify(found) !== JSON.stringify(value)) {
      throw new Error(
        `Recording differs: ${scenario} header ${key}\n  expected ${JSON.stringify(value)}\n  actual   ${JSON.stringify(found)}`
      )
    }
  }
  const expectedIds = pinned.recording.checkpoints.map((checkpoint) => checkpoint.id)
  const actualIds = actual.recording.checkpoints.map((checkpoint) => checkpoint.id)
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    const index = expectedIds.findIndex((id, at) => id !== actualIds[at])
    throw new Error(
      `Recording differs: ${scenario} checkpoint list (${expectedIds.length} expected, ${actualIds.length} actual)\n  first divergence at index ${index}: expected ${JSON.stringify(expectedIds[index])}, actual ${JSON.stringify(actualIds[index])}`
    )
  }
  for (const [index, checkpoint] of pinned.recording.checkpoints.entries()) {
    const found = actual.recording.checkpoints[index]!
    for (const field of OBSERVATION_FIELDS) {
      if (
        canonicalJson(checkpoint.observation[field]) === canonicalJson(found.observation[field])
      ) {
        continue
      }
      const path = firstDifference(checkpoint.observation[field], found.observation[field])
      throw new Error(
        `Recording differs: ${scenario} checkpoint ${checkpoint.id} field ${field}${path.path}\n  expected ${excerpt(path.expected)}\n  actual   ${excerpt(path.actual)}`
      )
    }
  }
  if (goldenBytes(pinned) !== goldenBytes(actual)) {
    throw new Error(`Recording differs: ${scenario} (encoding)`)
  }
}
function firstDifference(
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
      (entry, at) => canonicalJson(entry) !== canonicalJson(actual[at] as RecordedValue)
    )
    return index === -1 || index >= actual.length
      ? here
      : firstDifference(
          expected[index] as RecordedValue,
          actual[index] as RecordedValue,
          `${path}[${index}]`
        )
  }
  const left = expected as Record<string, RecordedValue>
  const right = actual as Record<string, RecordedValue>
  const key = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .find(
      (name) =>
        canonicalJson(left[name] as RecordedValue) !== canonicalJson(right[name] as RecordedValue)
    )
  return key === undefined || !(key in left) || !(key in right)
    ? here
    : firstDifference(left[key] as RecordedValue, right[key] as RecordedValue, `${path}.${key}`)
}
function excerpt(value: RecordedValue): string {
  const json = JSON.stringify(value)
  return json === undefined ? 'absent' : json.length > 600 ? `${json.slice(0, 600)}…` : json
}
