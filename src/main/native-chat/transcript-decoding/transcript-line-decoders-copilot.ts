// Copilot's events.jsonl interleaves the session's turns with subagent and bookkeeping records.
// Only the person's and the main assistant's words become chat blocks.

import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { extractAssistantContentText } from '../../../shared/agent-hook-listener/transcript-entry-text'
import { extractString } from '../../../shared/text/trimmed-string'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { timestampMs } from '../../ai-vault/parsing/session-record-time'

export function decodeCopilotTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record || record.agentId !== undefined) {
    return null
  }
  const data = asRecord(record.data)
  if (!data) {
    return null
  }
  let role: 'user' | 'assistant'
  let text: string | undefined
  if (record.type === 'user.message') {
    role = 'user'
    // transformedContent is the prompt plus injected context, not what the person typed.
    text = extractString(data.content) ?? extractString(data.transformedContent) ?? undefined
  } else if (record.type === 'assistant.message' && data.fusion === undefined) {
    role = 'assistant'
    text = extractAssistantContentText(data.content)
  } else {
    return null
  }
  if (!text) {
    return null
  }
  const timestamp = timestampMs(record.timestamp)
  return {
    id: fallbackId,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript'
  }
}
