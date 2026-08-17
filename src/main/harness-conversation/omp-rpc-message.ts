import { randomUUID } from 'node:crypto'
import type { HarnessConversationDriverSink } from './driver'

export type OmpAssistantMessage = {
  role: 'assistant'
  stopReason?: unknown
  content?: unknown
}

export type OmpTextStreams = Map<'assistant' | 'reasoning', { id: string; text: string }>

export function ompAssistantMessage(value: unknown): OmpAssistantMessage | null {
  if (!value || typeof value !== 'object' || (value as { role?: unknown }).role !== 'assistant') {
    return null
  }
  return value as OmpAssistantMessage
}

export function completeOmpResponse(
  sink: HarnessConversationDriverSink,
  streams: OmpTextStreams,
  responseId: string | null,
  message?: OmpAssistantMessage
): void {
  const terminalAnswer = isOmpTerminalAnswer(message)
  for (const [role, stream] of streams) {
    const text = (message ? ompMessageText(message, role) : '') || stream.text
    sink.emit({
      type: 'message.completed',
      message: {
        id: stream.id,
        role,
        blocks: [{ type: 'text', text }],
        timestamp: Date.now(),
        source: 'stream',
        ...(role === 'assistant' && !terminalAnswer
          ? { assistantPhase: 'commentary' as const }
          : {})
      }
    })
  }
  if (message && !streams.has('assistant')) {
    const text = ompMessageText(message, 'assistant')
    if (text) {
      sink.emit({
        type: 'message.completed',
        message: {
          id: `${responseId ?? `omp:response:${randomUUID()}`}:assistant`,
          role: 'assistant',
          blocks: [{ type: 'text', text }],
          timestamp: Date.now(),
          source: 'stream',
          ...(!terminalAnswer ? { assistantPhase: 'commentary' as const } : {})
        }
      })
    }
  }
  streams.clear()
}

function ompMessageText(message: OmpAssistantMessage, role: 'assistant' | 'reasoning'): string {
  if (!Array.isArray(message.content)) {
    return ''
  }
  const type = role === 'assistant' ? 'text' : 'thinking'
  const key = role === 'assistant' ? 'text' : 'thinking'
  return message.content
    .flatMap((block) => {
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== type) {
        return []
      }
      const text = (block as Record<string, unknown>)[key]
      return typeof text === 'string' ? [text] : []
    })
    .join('\n\n')
}

function isOmpTerminalAnswer(message?: OmpAssistantMessage): boolean {
  return Boolean(
    message?.stopReason === 'stop' &&
    ompMessageText(message, 'assistant').trim() &&
    Array.isArray(message.content) &&
    !message.content.some(
      (block) =>
        block && typeof block === 'object' && (block as { type?: unknown }).type === 'toolCall'
    )
  )
}
