import { readFileSync } from 'node:fs'
import type { RecordingScenario } from './recording-scenario'

function decode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decode)
  }
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && '$undefined' in value && value.$undefined === true) {
      return undefined
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]))
  }
  return value
}
/** Keys the format dropped. Refused rather than ignored, so a branch cut before the change says so. */
const RETIRED_MANIFEST_KEYS = ['baseline']
const RETIRED_SCENARIO_KEYS = ['version']

export function readScenarios(path: string): { scenarios: RecordingScenario[] } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the manifest shape is validated on the next lines.
  const input = decode(JSON.parse(readFileSync(path, 'utf8'))) as {
    scenarios: RecordingScenario[]
  }
  if (!Array.isArray(input.scenarios) || !input.scenarios.length) {
    throw new Error('Invalid recording manifest')
  }
  const retired = [
    ...RETIRED_MANIFEST_KEYS.filter((key) => key in input),
    ...input.scenarios.flatMap((scenario) =>
      RETIRED_SCENARIO_KEYS.filter((key) => key in scenario).map((key) => `${scenario.id}.${key}`)
    )
  ]
  if (retired.length) {
    throw new Error(
      `The recording manifest no longer carries a pin or scenario versions; remove: ${retired.join(', ')}`
    )
  }
  const ids = input.scenarios.map((scenario) => scenario.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate scenario ids')
  }
  return input
}
