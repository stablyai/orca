// Muse session.jsonl (<root>/YYYY/MM/DD/<uuid>/session.jsonl) holds a few conversation records
// among heavy runtime bookkeeping; everything but user intents and run message/tool/terminal
// events skips. Question prompts skip too: their request_user_input call and result already render.

import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage
} from '../../shared/native-chat/native-chat-types'
import { museTimestampMs } from '../ai-vault/scanners/muse/session-scanner-muse-parser'
import {
  arrayValue,
  asRecord,
  extractString,
  parseJsonObject
} from '../ai-vault/session-scanner-values'

export function decodeMuseTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!record || !payload) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = museTimestampMs(record.recorded_at)
  const message = (role: NativeChatMessage['role'], blocks: NativeChatBlock[]) =>
    blocks.length === 0 ? null : { id, role, blocks, timestamp, source: 'transcript' as const }

  if (record.payload_type === 'runtime.user_intent.accepted') {
    return message('user', textBlocks(payload.refill_blocks))
  }
  // Task-stream events (`payload.kind: 'task'`) are scheduler bookkeeping, not conversation.
  const event = payload.kind === 'run' ? asRecord(payload.event) : null
  switch (event?.kind) {
    case 'assistant_message_committed': {
      const text = extractString(event.text)
      return message('assistant', text ? [{ type: 'text', text }] : [])
    }
    case 'assistant_tool_calls_committed':
      return message('assistant', arrayValue(event.tool_calls).flatMap(toolCallBlock))
    case 'tool_result_batch_committed':
      return message('tool', arrayValue(event.results).flatMap(toolResultBlock))
    case 'terminal':
      return event.terminal === 'cancelled'
        ? message('system', [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }])
        : null
    default:
      return null
  }
}

function textBlocks(value: unknown): NativeChatBlock[] {
  return arrayValue(value).flatMap((block): NativeChatBlock[] => {
    const text = extractString(asRecord(block)?.text)
    return text ? [{ type: 'text', text }] : []
  })
}

function toolCallBlock(value: unknown): NativeChatBlock[] {
  const call = asRecord(value)
  if (!call) {
    return []
  }
  const callId = extractString(call.call_id)
  return [
    {
      type: 'tool-call',
      name: extractString(call.name) ?? 'tool',
      input: parseJsonText(call.args) ?? call.args ?? '',
      ...(callId ? { callId } : {})
    }
  ]
}

function toolResultBlock(value: unknown): NativeChatBlock[] {
  const result = asRecord(value)
  if (!result) {
    return []
  }
  const callId = extractString(result.tool_call_id)
  const text = typeof result.text === 'string' ? result.text : ''
  // bash/bash_input results are JSON envelopes; show their captured output, not the envelope.
  const shell = asRecord(parseJsonText(text))
  const shellOutput =
    typeof shell?.output === 'string' && typeof shell.terminal_status === 'string'
      ? shell.output
      : null
  return [
    {
      type: 'tool-result',
      output: shellOutput ?? text,
      ...(shellOutput !== null && shell?.terminal_status === 'failed' ? { isError: true } : {}),
      ...(callId ? { callId } : {})
    }
  ]
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return undefined
  }
}
