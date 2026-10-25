import { format } from 'oxfmt'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  checkpointListDifference,
  decodeGoldenFile,
  excerpt,
  groupDifferences,
  identityDifferences,
  recordingDifferences
} from './golden-difference'
import { internRecording } from './golden-value-pool'
import type { Recording, RecordingScenario } from './recording-scenario'

// Version 6 omits provenance; each run derives recordings from the current tree.
export const GOLDEN_FORMAT_VERSION = 6
const REPORTED_DIFFERENCES = 8
export type GoldenRecording = {
  goldenFormatVersion: number
  operation: string
  family: string
  namedDeltas: string[]
  recording: Recording
}

export function recordHint(id: string): string {
  return `If the change is intended, re-record it: pnpm --dir mobile rpc:record ${id}`
}
export function goldenRecording(
  scenarios: readonly RecordingScenario[],
  recording: Recording
): GoldenRecording {
  const [scenario] = scenarios
  if (!scenario) {
    throw new Error('A golden records at least one scenario')
  }
  return {
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    operation: scenario.operation,
    family: scenario.family,
    namedDeltas: scenario.namedDeltas ?? [],
    recording
  }
}
export function goldenBytes(golden: GoldenRecording): string {
  const { recording: _value, ...header } = golden
  const interned = internRecording(golden.recording)
  return `${JSON.stringify({ ...header, values: interned.values, recording: interned.recording }, null, 2)}\n`
}
export function readGolden(directory: string, id: string): GoldenRecording {
  const path = goldenPath(directory, id)
  if (!existsSync(path)) {
    throw new Error(`No golden recorded for ${id}. Record it: pnpm --dir mobile rpc:record ${id}`)
  }
  const file: unknown = withRecordHint(id, () => JSON.parse(readFileSync(path, 'utf8')))
  const version =
    file && typeof file === 'object' && 'goldenFormatVersion' in file
      ? file.goldenFormatVersion
      : undefined
  if (version !== GOLDEN_FORMAT_VERSION) {
    throw new Error(
      `Golden ${id} has format version ${JSON.stringify(version)}; this reader requires ${GOLDEN_FORMAT_VERSION}.\n${recordHint(id)}`
    )
  }
  return withRecordHint(id, () => ({
    goldenFormatVersion: GOLDEN_FORMAT_VERSION,
    ...decodeGoldenFile(file, id)
  }))
}
function withRecordHint<T>(id: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    throw new Error(
      `Golden ${id}: ${error instanceof Error ? error.message : String(error)}\n${recordHint(id)}`
    )
  }
}
export async function writeGolden(
  directory: string,
  golden: GoldenRecording,
  mode: string
): Promise<void> {
  if (mode !== '--record') {
    throw new Error('Golden writes require --record')
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(goldenPath(directory, golden.recording.scenario), await goldenFileText(golden))
}
async function goldenFileText(golden: GoldenRecording): Promise<string> {
  const result = await format(`${golden.recording.scenario}.json`, goldenBytes(golden), {
    printWidth: 100,
    trailingComma: 'none'
  })
  if (result.errors.length) {
    throw new Error('Cannot format golden')
  }
  return result.code
}
function goldenPath(directory: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error(`Unsafe scenario id: ${id}`)
  }
  return join(directory, `${id}.json`)
}
// Compare exact file text so stale keys, pool entries and hand edits cannot escape decoded-value checks.
export async function expectGoldenFile(
  directory: string,
  id: string,
  actual: GoldenRecording
): Promise<void> {
  const path = goldenPath(directory, id)
  if (existsSync(path) && readFileSync(path, 'utf8') === (await goldenFileText(actual))) {
    return
  }
  const problems = recordingProblems(readGolden(directory, id), actual)
  throw problems.length
    ? recordingDiffers(id, problems)
    : new Error(
        `Golden ${id} holds the same recording but is not the file rpc:record writes for it (a hand edit, a leftover key, a stale pool entry, or keys in another order).\n${recordHint(id)}`
      )
}
export function compareGolden(expected: GoldenRecording, actual: GoldenRecording): void {
  // Matching recordings need no field-by-field diagnostic strings, but still pin encoded bytes.
  if (isDeepStrictEqual(expected, actual) && goldenBytes(expected) === goldenBytes(actual)) {
    return
  }
  const problems = recordingProblems(expected, actual)
  // The field compares ignore key order and the re-encoded bytes do not, so the bytes decide last.
  if (!problems.length && goldenBytes(expected) !== goldenBytes(actual)) {
    problems.push('encoding: every field matches but the encoded bytes do not')
  }
  if (problems.length) {
    throw recordingDiffers(actual.recording.scenario, problems)
  }
}
function recordingDiffers(scenario: string, problems: readonly string[]): Error {
  return new Error(
    `Recording differs: ${scenario}\n  ${problems.join('\n  ')}\n${recordHint(scenario)}`
  )
}
function recordingProblems(expected: GoldenRecording, actual: GoldenRecording): string[] {
  const problems: string[] = identityDifferences(expected, actual).map(
    (moved) =>
      `${moved.field}\n    expected ${JSON.stringify(moved.expected)}\n    actual   ${JSON.stringify(moved.actual)}`
  )
  const list = checkpointListDifference(expected.recording, actual.recording)
  if (list.missing.length || list.extra.length || list.reordered) {
    problems.push(
      [
        'checkpoint list',
        ...(list.missing.length ? [`    no longer recorded: ${list.missing.join(', ')}`] : []),
        ...(list.extra.length ? [`    newly recorded: ${list.extra.join(', ')}`] : []),
        ...(list.reordered ? ['    shared checkpoints recorded in a different order'] : [])
      ].join('\n')
    )
  }
  const differences = groupDifferences(recordingDifferences(expected.recording, actual.recording))
  for (const difference of differences.slice(0, REPORTED_DIFFERENCES)) {
    const [first, ...rest] = difference.checkpoints
    const also = rest.length ? ` (and ${rest.length} later)` : ''
    problems.push(
      `checkpoint ${first} field ${difference.field}${difference.path}${also}\n    expected ${excerpt(difference.expected)}\n    actual   ${excerpt(difference.actual)}`
    )
  }
  if (differences.length > REPORTED_DIFFERENCES) {
    problems.push(`… ${differences.length - REPORTED_DIFFERENCES} more differences`)
  }
  return problems
}
