import { timestampIso } from './session-scanner-accumulator'
import { asRecord } from './session-scanner-record-value'
import type { SessionAccumulator } from './session-scanner-types'
import { transcriptMessagesFromContent } from './session-transcript-message-content'

export const CODEX_TOOL_RESPONSE_TYPES = new Set([
  'function_call',
  'local_shell_call',
  'custom_tool_call',
  'function_call_output',
  'custom_tool_call_output'
])

function publishToolContent(
  accumulator: SessionAccumulator,
  content: unknown,
  timestamp: unknown
): void {
  for (const message of transcriptMessagesFromContent('tool', content, timestampIso(timestamp))) {
    accumulator.messages.push(message)
  }
}

export function publishCodexResponseTool(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestamp: unknown
): void {
  if (!accumulator.messages.active || !CODEX_TOOL_RESPONSE_TYPES.has(String(payload.type))) {
    return
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = asRecord(payload.output)
    publishToolContent(
      accumulator,
      [{ type: 'tool_result', content: output?.content ?? output?.output ?? payload.output }],
      timestamp
    )
    return
  }
  const input = payload.arguments ?? payload.input ?? payload.action
  const action = asRecord(input)
  const normalizedInput =
    action && Array.isArray(action.command)
      ? { ...action, command: action.command.filter((part) => typeof part === 'string').join(' ') }
      : input
  publishToolContent(
    accumulator,
    [
      {
        type: 'tool_use',
        name: payload.name ?? 'tool',
        input: normalizedInput
      }
    ],
    timestamp
  )
}

export function publishCodexCompletedTool(
  accumulator: SessionAccumulator,
  payload: Record<string, unknown>,
  timestamp: unknown
): void {
  if (!accumulator.messages.active) {
    return
  }
  const item = asRecord(payload.item)
  if (item?.type === 'CommandExecution' || item?.type === 'command_execution') {
    const command = Array.isArray(item.command)
      ? item.command.filter((part) => typeof part === 'string').join(' ')
      : item.command
    publishToolContent(
      accumulator,
      [
        { type: 'tool_use', name: 'shell', input: command },
        { type: 'tool_result', content: item.aggregated_output ?? item.aggregatedOutput }
      ],
      timestamp
    )
  } else if (item?.type === 'FileChange' || item?.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    for (const value of changes) {
      const change = asRecord(value)
      publishToolContent(
        accumulator,
        [
          { type: 'tool_use', name: 'apply_patch', input: { path: change?.path } },
          { type: 'tool_result', content: change?.diff }
        ],
        timestamp
      )
    }
  }
}
