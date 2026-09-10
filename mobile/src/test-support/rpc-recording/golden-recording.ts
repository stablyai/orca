import { format } from 'oxfmt'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Recording, RecordingScenario } from './recording-scenario'

export const RUNNER_VERSION = 1
export type GoldenRecording = {
  operation: string
  family: string
  namedDeltas: string[]
  runnerVersion: number
  baseline: string
  lockfileSha256: string
  platform: string
  scenarioVersion: number
  projectionVersion: number
  recording: Recording
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
    platform: process.platform,
    scenarioVersion: scenario.version,
    projectionVersion: 1,
    recording
  }
}
export function goldenBytes(golden: GoldenRecording): string {
  return `${JSON.stringify(golden, null, 2)}\n`
}
export function readGolden(directory: string, id: string): GoldenRecording {
  return JSON.parse(readFileSync(goldenPath(directory, id), 'utf8')) as GoldenRecording
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
  // Platform is provenance; cross-platform candidates still compare the complete behavioral trace.
  if (goldenBytes({ ...expected, platform: actual.platform }) !== goldenBytes(actual)) {
    throw new Error(`Recording differs: ${actual.recording.scenario}`)
  }
}
