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
export function readScenarios(path: string): { baseline: string; scenarios: RecordingScenario[] } {
  const input = decode(JSON.parse(readFileSync(path, 'utf8'))) as {
    baseline: string
    scenarios: RecordingScenario[]
  }
  if (
    !/^[a-f0-9]{40}$/.test(input.baseline) ||
    !Array.isArray(input.scenarios) ||
    !input.scenarios.length
  ) {
    throw new Error('Invalid recording manifest')
  }
  const ids = input.scenarios.map((scenario) => scenario.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate scenario ids')
  }
  return input
}
