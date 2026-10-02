import { basename, dirname } from 'node:path'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { isSafeGrokSessionId } from '../../shared/grok-session-paths'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import { toolResultOutput } from './transcript-record-blocks'

/** Grok persists coalesced presentation updates separately from compactable model context. */
export function decodeGrokTranscriptUpdate(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  const params = asRecord(record?.params)
  const update = asRecord(params?.update)
  const filePath = fallbackId.slice(0, fallbackId.lastIndexOf(':'))
  const sessionId = basename(dirname(filePath))
  if (
    record?.method !== 'session/update' ||
    basename(filePath) !== 'updates.jsonl' ||
    !isSafeGrokSessionId(sessionId) ||
    params?.sessionId !== sessionId ||
    !update
  ) {
    return null
  }
  let role: NativeChatMessage['role']
  let blocks: NativeChatBlock[]
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      role =
        update.sessionUpdate === 'user_message_chunk'
          ? 'user'
          : update.sessionUpdate === 'agent_thought_chunk'
            ? 'reasoning'
            : 'assistant'
      blocks = contentBlocks(update.content, role === 'user')
      break
    case 'tool_call': {
      const toolCallId = extractString(update.toolCallId)
      if (!toolCallId) {
        return null
      }
      role = 'assistant'
      blocks = [
        {
          type: 'tool-call',
          callId: toolCallId,
          name: extractString(update.name) ?? extractString(update.title) ?? 'Tool',
          input: update.rawInput,
          state:
            update.status === 'failed'
              ? 'failed'
              : update.status === 'completed'
                ? 'completed'
                : 'running'
        },
        ...toolResultBlocks(update, toolCallId)
      ]
      break
    }
    case 'tool_call_update': {
      const toolCallId = extractString(update.toolCallId)
      if (!toolCallId) {
        return null
      }
      role = 'tool'
      blocks = toolResultBlocks(update, toolCallId)
      break
    }
    default:
      return null
  }
  if (!blocks.length) {
    return null
  }
  return {
    id: fallbackId,
    role,
    blocks,
    timestamp:
      typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
        ? record.timestamp * 1000
        : null,
    source: 'transcript'
  }
}

function toolResultBlocks(update: Record<string, unknown>, toolCallId: string): NativeChatBlock[] {
  if (
    update.rawOutput === undefined &&
    update.content === undefined &&
    update.status !== 'completed' &&
    update.status !== 'failed'
  ) {
    return []
  }
  const content = Array.isArray(update.content)
    ? update.content.map((item) => asRecord(item)?.content ?? item)
    : update.content
  const output = update.rawOutput ?? content
  return [
    {
      type: 'tool-result',
      callId: toolCallId,
      output:
        toolResultOutput(output) ||
        (Array.isArray(output) && output.length ? JSON.stringify(output) : ''),
      ...(update.status === 'failed' ? { isError: true } : {}),
      ...(update.status === 'in_progress' || update.status === 'pending' ? { isPartial: true } : {})
    }
  ]
}

function contentBlocks(value: unknown, stripContext = false): NativeChatBlock[] {
  const content = asRecord(value)
  if (!content) {
    return []
  }
  if (content.type === 'text' && typeof content.text === 'string' && content.text.length) {
    const text = stripContext ? stripGrokContextWrappers(content.text) : content.text
    return text ? [{ type: 'text', text }] : []
  }
  if (
    content.type === 'image' &&
    typeof content.data === 'string' &&
    typeof content.mimeType === 'string' &&
    /^image\/[a-z0-9.+-]+$/i.test(content.mimeType)
  ) {
    return [{ type: 'image-ref', url: `data:${content.mimeType};base64,${content.data}` }]
  }
  if (content.type === 'resource_link' && typeof content.uri === 'string') {
    return [{ type: 'text', text: extractString(content.name) ?? content.uri }]
  }
  const resource = asRecord(content.resource)
  return content.type === 'resource' && typeof resource?.text === 'string'
    ? [{ type: 'text', text: resource.text }]
    : []
}

function stripGrokContextWrappers(text: string): string {
  for (const tag of ['fork-context', 'resume-context']) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    const start = text.indexOf(open)
    const end = start === -1 ? -1 : text.indexOf(close, start + open.length)
    if (end >= 0) {
      text = text.slice(0, start) + text.slice(end + close.length).trimStart()
    }
  }
  return text
}
