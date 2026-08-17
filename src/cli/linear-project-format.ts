import type {
  LinearProjectLabelsResult,
  LinearProjectStatusesResult
} from '../shared/linear/project-agent-access'
import {
  LINEAR_PROJECT_LABELS_NOUN,
  LINEAR_PROJECT_STATUSES_NOUN,
  linearProjectFanoutWarningLines
} from '../shared/linear/project-agent-format'
import { prepareComputerCliJsonResult } from './computer-format'
import type { RuntimeRpcSuccess } from './runtime/types'

// Why: JSON.stringify escapes C0 but emits DEL and C1 raw, which still drive a terminal.
// eslint-disable-next-line no-control-regex -- this pattern exists to match terminal control bytes.
const JSON_RAW_CONTROL_PATTERN = /[\u007f-\u009f]/g

export {
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  formatLinearProjectUpdateAdd,
  sanitizeLinearProjectText,
  toSingleLineLinearProjectText
} from '../shared/linear/project-agent-format'

/**
 * Escape the control bytes `JSON.stringify` leaves raw. Only string literals can
 * contain them, so `JSON.parse` still reproduces the original values exactly.
 */
export function escapeJsonControlCharacters(serialized: string): string {
  return serialized.replace(
    JSON_RAW_CONTROL_PATTERN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

export function printLinearProjectResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (json) {
    console.log(
      escapeJsonControlCharacters(JSON.stringify(prepareComputerCliJsonResult(response), null, 2))
    )
    return
  }
  console.log(formatter(response.result))
}

export function printLinearProjectStatusesWarnings(result: LinearProjectStatusesResult): void {
  printWarnings(linearProjectFanoutWarningLines(result.meta, LINEAR_PROJECT_STATUSES_NOUN))
}

export function printLinearProjectLabelsWarnings(result: LinearProjectLabelsResult): void {
  printWarnings(linearProjectFanoutWarningLines(result.meta, LINEAR_PROJECT_LABELS_NOUN))
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(warning)
  }
}
