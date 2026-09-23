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
    return { presence: AUTOMATION_RUNS_ABSENT, payload: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (parsed === null) {
    return { presence: AUTOMATION_RUNS_NULL, payload: 'null' }
  }
  if (!Array.isArray(parsed)) {
    return undefined
  }
  const runs = parseAutomationRunValues(parsed)
  if (runs === undefined) {
    return undefined
  }
  return {
    presence: AUTOMATION_RUNS_ARRAY,
    payload: `[${runs.map((run) => run.payload).join(',')}]`,
    runs
  }
}

export function parseAutomationRunValues(
  values: readonly unknown[]
): AutomationRunPayload[] | undefined {
  const ids = new Set<string>()
  const runs: AutomationRunPayload[] = []
  for (const [ordinal, value] of values.entries()) {
    if (!isRecord(value) || typeof value.id !== 'string' || ids.has(value.id)) {
      return undefined
    }
    const runPayload = JSON.stringify(value)
    if (runPayload === undefined) {
      return undefined
    }
    ids.add(value.id)
    runs.push({
      id: value.id,
      ordinal,
      payload: runPayload,
      contentHash: hashProfileStatePayload(runPayload)
    })
  }
  return runs
}

export function hashAutomationRunsReplacement(
  replacement: ParsedAutomationRunsReplacement
): string {
  if (replacement.presence === AUTOMATION_RUNS_ABSENT) {
    return ''
  }
  return hashProfileStatePayload(replacement.payload)
}
