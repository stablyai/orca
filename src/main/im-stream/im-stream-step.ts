import type { AgentJournalToolCallState } from '../../shared/agent-session/journal/agent-session-journal-types'
import { connectorTurnActivityLine } from '../../shared/connectors/connector-turn-activity-line'
import {
  describeToolInput,
  normalizeToolInput
} from '../../shared/native-chat/tools/native-chat-tool-summary'
import { sliceAtCodeUnitLimit } from '../../shared/text/surrogate-safe-text-slice'
import { maskImLines, maskImText, maskImValues } from './im-stream-mask'

export const IM_STEP_SUMMARY_CHARS = 80
const IM_STEP_NAME_CHARS = 40

export type ImStepState = AgentJournalToolCallState

export type ImStep = {
  /** The tool call's journal row, the same across reads. */
  id: string
  /** The tool as an IM names it: `mcp__server__tool` reads as `server/tool`. */
  name: string
  /** The input's first line; null when it looked like it held a secret. */
  detail: string | null
  /** What the step does, in one line ("Running pnpm test"); never the tool's output. */
  summary: string
  state: ImStepState
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${sliceAtCodeUnitLimit(line, max - 1).trimEnd()}…`
}

// Before a preview clips it, so a value cut in half can't slip past the patterns.
function maskedInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return maskImValues(value)
  }
  if (Array.isArray(value)) {
    return value.map(maskedInput)
  }
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, each]) => [key, maskedInput(each)]))
    : value
}

function toolLabel(name: string): string {
  const [prefix, server, tool] = name.split('__')
  return prefix === 'mcp' && server ? (tool ? `${server}/${tool}` : server) : name
}

function inputLine(input: unknown): string {
  try {
    return describeToolInput(maskedInput(normalizeToolInput(input))).split('\n')[0] ?? ''
  } catch {
    // An input no preview can read still shows the tool's name.
    return ''
  }
}

/** A tool step as an IM shows it, from its journal row: every field masked. */
export function imStep(id: string, toolName: string, input: unknown, state: ImStepState): ImStep {
  const raw = toolName.trim() || 'tool'
  const line = inputLine(input)
  const detail = maskImLines(line)
  const summary = connectorTurnActivityLine(raw, line) ?? `Using ${raw}`
  return {
    id,
    name: clip(maskImText(toolLabel(raw)), IM_STEP_NAME_CHARS) || 'tool',
    detail:
      detail.leftOut > 0 || !detail.text.trim() ? null : clip(detail.text, IM_STEP_SUMMARY_CHARS),
    summary: clip(maskImText(summary), IM_STEP_SUMMARY_CHARS),
    state
  }
}
