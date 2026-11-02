import { createHash } from 'node:crypto'
import { timestampIso, updateTimeline } from './session-scanner-accumulator'
import { addSessionContent } from './session-scanner-messages'
import {
  boundedText,
  toolCallContent,
  transcriptMessagesFromContent
} from './session-transcript-message-content'
import {
  asRecord,
  extractContentText,
  extractString,
  parseJsonObject
} from './session-scanner-values'
import type { SessionAccumulator } from './session-scanner-types'

// Pair canonical messages with context mirrors while retaining stream-only turns.
export function createKimiV2WireConsumer(accumulator: SessionAccumulator, preview = true) {
  const seen = new Set<string>()
  const contextMessages = { user: new Map<string, number>(), assistant: new Map<string, number>() }
  const canonicalMessages = {
    user: new Map<string, number>(),
    assistant: new Map<string, number>()
  }
  let assistantParts: string[] = []
  let assistantTime: unknown
  const first = (kind: string, id: unknown, text: string, time: unknown): boolean => {
    const hash = createHash('sha256').update(text).digest('hex')
    const key = `${kind}:${extractString(id) ?? timestampIso(time)}:${hash}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  }
  const tool = (
    kind: string,
    id: unknown,
    text: string | null,
    time: unknown,
    truncated = false
  ): void => {
    if (!accumulator.messages.active || !text) {
      return
    }
    const bounded = boundedText(text)
    if (bounded && first(kind, id, bounded, time)) {
      accumulator.messages.push({
        role: 'tool',
        text: bounded,
        timestamp: timestampIso(time),
        ...(truncated || bounded.length < text.length ? { textTruncated: true as const } : {})
      })
    }
  }
  const call = (value: unknown, time: unknown): void => {
    const record = asRecord(value)
    if (!record) {
      return
    }
    const raw = record.args ?? record.arguments
    const args = typeof raw === 'string' ? (parseJsonObject(raw) ?? raw) : raw
    const content = toolCallContent(record.name, args)
    tool('call', record.toolCallId ?? record.id, content.text, time, content.textTruncated)
  }
  const publish = (
    role: 'user' | 'assistant',
    content: unknown,
    time: unknown,
    source: 'context' | 'canonical',
    identity?: unknown
  ): void => {
    const timestamp = timestampIso(time)
    const messages = transcriptMessagesFromContent(role, content, timestamp)
    const text = messages.map((message) => message.text).join('\n')
    if (!text || (source === 'canonical' && !first(role, identity, text, time))) {
      return
    }
    const key = createHash('sha256').update(text).digest('hex')
    const other = source === 'context' ? canonicalMessages[role] : contextMessages[role]
    const own = source === 'context' ? contextMessages[role] : canonicalMessages[role]
    const matches = other.get(key) ?? 0
    if (matches > 0) {
      if (matches === 1) {
        other.delete(key)
      } else {
        other.set(key, matches - 1)
      }
      return
    }
    own.set(key, (own.get(key) ?? 0) + 1)
    updateTimeline(accumulator, time)
    if (preview) {
      if (role === 'user') {
        accumulator.title ??= extractContentText(content)
      }
      accumulator.messageCount++
      addSessionContent(accumulator, role, content, time)
    } else {
      for (const message of messages) {
        accumulator.messages.push(message)
      }
    }
  }
  const flushAssistant = (): void => {
    const text = assistantParts.join('')
    assistantParts = []
    if (text) {
      publish('assistant', text, assistantTime, 'context')
    }
    assistantTime = undefined
  }
  return {
    finish: flushAssistant,
    consume(record: Record<string, unknown>): boolean {
      const time = record.time
      if (record.type === 'context.append_message') {
        const message = asRecord(record.message)
        if (message?.role === 'user' && asRecord(message.origin)?.kind === 'user') {
          contextMessages.assistant.clear()
          canonicalMessages.assistant.clear()
          publish('user', message.content, time, 'context')
        }
        return true
      }
      if (record.type === 'context.append_loop_event') {
        const event = asRecord(record.event)
        if (event?.type === 'content.part') {
          const part = asRecord(event.part)
          if (part?.type === 'text' && typeof part.text === 'string') {
            assistantParts.push(part.text)
            assistantTime ??= time
          }
        }
        if (event?.type === 'step.end') {
          flushAssistant()
          contextMessages.user.clear()
          canonicalMessages.user.clear()
        }
        if (event?.type === 'tool.call' || event?.type === 'tool.result') {
          updateTimeline(accumulator, time)
        }
        if (event?.type === 'tool.call') {
          call(event, time)
        }
        if (event?.type === 'tool.result') {
          const output = asRecord(event.result)?.output
          for (const message of transcriptMessagesFromContent('tool', output, timestampIso(time))) {
            tool('result', event.toolCallId, message.text, time, message.textTruncated)
          }
        }
        return true
      }
      if (record.type !== 'agent.message.appended') {
        return false
      }
      const envelope = asRecord(record.message)
      const message = asRecord(envelope?.message)
      const meta = asRecord(envelope?.meta)
      if (!message) {
        return true
      }
      const timestamp = time ?? meta?.createdAt
      updateTimeline(accumulator, timestamp)
      if (message.role === 'tool') {
        for (const item of transcriptMessagesFromContent(
          'tool',
          message.content,
          timestampIso(timestamp)
        )) {
          tool('result', message.toolCallId, item.text, timestamp, item.textTruncated)
        }
        return true
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        return true
      }
      if (message.role === 'user' && asRecord(meta?.origin)?.kind === 'injection') {
        return true
      }
      if (message.role === 'user') {
        contextMessages.assistant.clear()
        canonicalMessages.assistant.clear()
      }
      publish(
        message.role,
        message.content,
        timestamp,
        'canonical',
        meta?.messageId ?? meta?.userMessageId
      )
      if (Array.isArray(message.toolCalls)) {
        for (const item of message.toolCalls) {
          call(item, timestamp)
        }
      }
      return true
    }
  }
}
