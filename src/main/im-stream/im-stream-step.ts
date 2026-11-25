import { connectorTurnActivityLine } from '../../shared/connectors/connector-turn-activity-line'
import {
  describeToolInput,
  normalizeToolInput
} from '../../shared/native-chat/tools/native-chat-tool-summary'
import { redactString } from '../../shared/observability/redactor'

export const IM_STEP_SUMMARY_CHARS = 80

export type ImStepState = 'running' | 'done' | 'failed'
export type ImStep = { name: string; summary: string; state: ImStepState }

// `KEY=value cmd`, `export KEY="x"`: an assignment's value never shows, whatever its name says.
const ASSIGNMENT =
  /(^|[\s;&|(])((?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g
// A URL's userinfo (whatever stands between `scheme://` and `@host`) never shows.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi

/** Text bound for an IM: variable assignments and URL credentials lose their values, and anything
 *  else shaped like a key, token or credential is masked. */
export function maskImText(text: string): string {
  return redactString(text.replace(URL_CREDENTIALS, '$1…@').replace(ASSIGNMENT, '$1$2=…'))
}

// Before a preview clips it, so a value cut in half can't slip past the patterns.
function maskedInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskImText(value)
  }
  if (Array.isArray(value)) {
    return value.map(maskedInput)
  }
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, maskedInput(each)]))
    : value
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** A tool step as an IM shows it: the tool's name and a short line about its input, never its output. */
export function imStep(name: string, input: unknown, state: ImStepState): ImStep {
  const toolName = clip(maskImText(name), 40) || 'tool'
  let detail = ''
  try {
    detail = describeToolInput(maskedInput(normalizeToolInput(input)))
  } catch {
    // An input no preview can read still shows the tool's name.
  }
  const line = connectorTurnActivityLine(toolName, detail) ?? `Using ${toolName}`
  return { name: toolName, summary: clip(maskImText(line), IM_STEP_SUMMARY_CHARS), state }
}
