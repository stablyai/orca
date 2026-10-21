import { createHash } from 'node:crypto'
import { hashProfileStatePayload, isRecord } from './profile-state-document-validation'
import {
  AUTOMATION_RUNS_ABSENT,
  AUTOMATION_RUNS_ARRAY,
  AUTOMATION_RUNS_NULL,
  type AutomationRunPayload,
  type ParsedAutomationRunsReplacement
} from './profile-state-automation-runs-model'

export function parseAutomationRunsReplacement(
  payload: string | null
): ParsedAutomationRunsReplacement | undefined {
  if (payload === null) {
    return parseAutomationRunsValue(undefined)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  return parseAutomationRunsValue(parsed)
}

export function parseAutomationRunsValue(
  value: unknown
): ParsedAutomationRunsReplacement | undefined {
  if (value === undefined) {
    return { presence: AUTOMATION_RUNS_ABSENT, contentHash: '' }
  }
  if (value === null) {
    return { presence: AUTOMATION_RUNS_NULL, contentHash: hashProfileStatePayload('null') }
  }
  if (!Array.isArray(value)) {
    return undefined
  }
  return parseAutomationRunValues(value)
}

export function parseAutomationRunValues(
  values: readonly unknown[]
): ParsedAutomationRunsReplacement | undefined {
  const ids = new Set<string>()
  const runs: AutomationRunPayload[] = []
  const aggregate = createHash('sha256').update('[')
  for (const [ordinal, value] of values.entries()) {
    if (!isRecord(value) || typeof value.id !== 'string' || ids.has(value.id)) {
      return undefined
    }
    const runPayload = JSON.stringify(value)
    if (runPayload === undefined) {
      return undefined
    }
    if (ordinal > 0) {
      aggregate.update(',')
    }
    aggregate.update(runPayload, 'utf8')
    ids.add(value.id)
    runs.push({
      id: value.id,
      ordinal,
      payload: runPayload,
      contentHash: hashProfileStatePayload(runPayload)
    })
  }
  return {
    presence: AUTOMATION_RUNS_ARRAY,
    contentHash: aggregate.update(']').digest('hex'),
    runs
  }
}
