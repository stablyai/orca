import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export function claudeProviderFrameKind(message: Record<string, unknown>): string {
  const type = claudeText(message.type) ?? 'unknown'
  const subtype = claudeText(message.subtype)
  const eventType = claudeText(claudeRecord(message.event)?.type)
  return ['message', type, subtype ?? eventType].filter(Boolean).join(':')
}

export function isModeledClaudeContent(value: unknown): boolean {
  const part = claudeRecord(value)
  if (!part) {
    return false
  }
  if (part.type === 'text') {
    return claudeText(part.text) !== null
  }
  if (part.type === 'image') {
    const source = claudeRecord(part.source)
    return source?.type === 'url' && claudeText(source.url) !== null
  }
  if (part.type === 'tool_use') {
    return claudeText(part.id) !== null && claudeText(part.name) !== null
  }
  if (part.type === 'tool_result') {
    return claudeText(part.tool_use_id) !== null
  }
  return part.type === 'thinking' && claudeText(part.thinking) !== null
}

export function createClaudeProviderFrameFallback(sink: StructuredAgentSessionEventSink): {
  append: (kind: string, payload: unknown) => void
} {
  let sequence = 0
  return {
    append: (kind, payload) => {
      sequence += 1
      const translated = unhandledProviderFrameJournalItem('claude', kind, payload)
      sink.appendItem(
        { provider: 'orca', clientMessageId: `provider-frame:claude:${sequence}` },
        translated.body,
        translated.blobs
      )
      sink.publish()
    }
  }
}
