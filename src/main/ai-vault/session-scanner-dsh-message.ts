import { asRecord, extractString } from './session-scanner-values'
import type { TranscriptMessageRole } from './session-transcript-consumers'

type DshHistoryMessage = {
  role: TranscriptMessageRole
  content: unknown
  source: Record<string, unknown> | null
}

// Released v0 flat payloads and v0–v3 tool wrappers precede v4 first-class tool messages.
export function dshHistoryMessage(
  type: unknown,
  data: Record<string, unknown>,
  version: number
): DshHistoryMessage | null {
  const message = type === 'user/message' ? data : asRecord(data.message)
  const source = asRecord(message?.source)
  if (type === 'user/message' && message && source?.kind === 'user') {
    return message?.role === 'user' || (version === 0 && message?.role === undefined)
      ? { role: 'user', content: message.content, source }
      : null
  }
  if (type === 'assistant/message') {
    if (message?.role === 'assistant' && source?.kind === 'model') {
      return { role: 'assistant', content: message.content, source }
    }
    const legacySource = version === 0 && !message ? asRecord(data.provenance) : null
    return legacySource ? { role: 'assistant', content: data.content, source: legacySource } : null
  }
  if (type !== 'tool/result') {
    return null
  }
  if (
    version === 0 &&
    !message &&
    extractString(data.callId) &&
    typeof data.isError === 'boolean'
  ) {
    return { role: 'tool', content: data.content, source: null }
  }
  const callId = extractString(source?.callId)
  if (source?.kind !== 'tool' || !callId) {
    return null
  }
  if (version === 4) {
    return message?.role === 'tool' && message.toolCallId === callId
      ? { role: 'tool', content: message.content, source }
      : null
  }
  const wrapper =
    Array.isArray(message?.content) && message.content.length === 1
      ? asRecord(message.content[0])
      : null
  return message?.role === 'user' &&
    wrapper?.type === 'tool-result' &&
    wrapper.toolCallId === callId
    ? { role: 'tool', content: wrapper.content, source }
    : null
}
