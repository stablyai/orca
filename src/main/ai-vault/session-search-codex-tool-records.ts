import { asRecord, extractString } from './session-scanner-values'
import { captureIndexableText, toolCallText } from './session-search-content'
import { isSessionSearchCaptureActive } from './session-search-capture'

// Codex writes tool traffic twice: the raw model call/output as response_item
// records, and a rendered CommandExecution/FileChange item once the turn
// completes. Index the rendered item when the history is paginated (it has the
// real argv and output) and the raw pair otherwise, so nothing is stored twice.
const RAW_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])
const RAW_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output'])

function argvText(command: unknown): string | null {
  if (typeof command === 'string') {
    return command
  }
  return Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string').join(' ')
    : null
}

export function captureCodexToolRecord(
  recordType: unknown,
  payload: Record<string, unknown>,
  timestamp: unknown,
  historyMode: string | null
): void {
  if (!isSessionSearchCaptureActive()) {
    return
  }
  const payloadType = extractString(payload.type)
  if (recordType === 'response_item' && payloadType) {
    if (historyMode === 'paginated') {
      return
    }
    if (RAW_CALL_TYPES.has(payloadType)) {
      const input = payload.arguments ?? payload.input ?? asRecord(payload.action)?.command
      captureIndexableText('tool', toolCallText(payload.name ?? 'shell', input), timestamp)
    } else if (RAW_OUTPUT_TYPES.has(payloadType)) {
      captureIndexableText('tool', extractString(payload.output), timestamp)
    }
    return
  }
  if (recordType !== 'event_msg' || payloadType !== 'item_completed') {
    return
  }
  const item = asRecord(payload.item)
  const itemType = item ? extractString(item.type) : null
  if (!item || !itemType) {
    return
  }
  if (itemType === 'CommandExecution') {
    captureIndexableText('tool', argvText(item.command), timestamp)
    captureIndexableText(
      'tool',
      extractString(item.aggregated_output) ?? extractString(item.stdout),
      timestamp
    )
    return
  }
  if (itemType === 'FileChange') {
    const changes = asRecord(item.changes)
    const paths = changes ? Object.keys(changes).join(' ') : null
    captureIndexableText(
      'tool',
      paths ? `FileChange: ${paths}` : extractString(item.stdout),
      timestamp
    )
    return
  }
  if (itemType === 'Reasoning') {
    captureIndexableText('assistant', extractString(item.text), timestamp)
  }
}
