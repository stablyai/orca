import { connectorTurnActivityLine } from '../../shared/connectors/connector-turn-activity-line'
import { describeToolInput } from '../../shared/native-chat/tools/native-chat-tool-summary'
import { redactString } from '../../shared/observability/redactor'

export const IM_STEP_SUMMARY_CHARS = 80

export type ImStepState = 'running' | 'done' | 'failed'
export type ImStep = { name: string; summary: string; state: ImStepState }

/** Text bound for an IM: anything shaped like a key, token or credential assignment is masked. */
export function maskImText(text: string): string {
  return redactString(text)
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
    detail = describeToolInput(input)
  } catch {
    // An input no preview can read still shows the tool's name.
  }
  const line = connectorTurnActivityLine(toolName, detail) ?? `Using ${toolName}`
  return { name: toolName, summary: clip(maskImText(line), IM_STEP_SUMMARY_CHARS), state }
}
