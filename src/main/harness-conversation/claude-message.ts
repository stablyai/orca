import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredProviderInput } from '../../shared/structured-agent-provider'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import type { HarnessConversationDriverSink } from './driver'

export function claudeTextMessage(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  assistantPhase?: NativeChatMessage['assistantPhase']
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: Date.now(),
    source: 'stream',
    ...(assistantPhase ? { assistantPhase } : {})
  }
}

export function emitClaudeAssistant(
  sink: HarnessConversationDriverSink,
  message: SDKAssistantMessage,
  streamingId: string | null,
  streamedText: Map<string, string>
): string | null {
  const finalId = streamingId ?? `claude:${message.uuid}`
  const blocks: NativeChatBlock[] = []
  const reasoning: string[] = []
  for (const block of message.message.content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking') {
      reasoning.push(block.thinking)
    } else if (block.type === 'tool_use') {
      blocks.push({ type: 'tool-call', toolCallId: block.id, name: block.name, input: block.input })
    }
  }
  const timestamp = Date.now()
  if (reasoning.length) {
    sink.emit({
      type: 'message.completed',
      message: {
        ...claudeTextMessage(`${finalId}:reasoning`, 'reasoning', reasoning.join('\n')),
        timestamp: timestamp - 1
      }
    })
  }
  const hasToolCall = blocks.some((block) => block.type === 'tool-call')
  if (blocks.length > 0) {
    sink.emit({
      type: 'message.completed',
      message: {
        ...claudeTextMessage(finalId, 'assistant', '', hasToolCall ? 'commentary' : undefined),
        blocks,
        timestamp
      }
    })
  }
  streamedText.delete(finalId)
  streamedText.delete(`${finalId}:reasoning`)
  return hasToolCall || !blocks.some((block) => block.type === 'text') ? null : finalId
}

export function emitClaudeToolResults(
  sink: HarnessConversationDriverSink,
  message: Extract<SDKMessage, { type: 'user' }>
): void {
  const content = Array.isArray(message.message.content) ? message.message.content : []
  for (const block of content) {
    if (block.type !== 'tool_result') {
      continue
    }
    const output =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
          : JSON.stringify(message.tool_use_result ?? '')
    sink.emit({
      type: 'message.completed',
      message: {
        id: `claude:tool:${block.tool_use_id}`,
        role: 'tool',
        blocks: [
          {
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            output,
            isError: block.is_error
          }
        ],
        timestamp: Date.now(),
        source: 'stream'
      }
    })
  }
}

export function emitClaudeStreamDelta(
  sink: HarnessConversationDriverSink,
  event: Record<string, unknown>,
  fallbackId: string,
  streamingId: string | null,
  streamedText: Map<string, string>
): void {
  const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined
  const role = delta?.type === 'thinking_delta' ? 'reasoning' : 'assistant'
  const text = role === 'reasoning' ? delta?.thinking : delta?.text
  if (typeof text !== 'string') {
    return
  }
  const baseId = streamingId ?? `claude:${fallbackId}`
  const messageId = role === 'reasoning' ? `${baseId}:reasoning` : baseId
  const current = streamedText.get(messageId) ?? ''
  if (!streamedText.has(messageId)) {
    sink.emit({ type: 'message.started', message: claudeTextMessage(messageId, role, '') })
  }
  streamedText.set(messageId, current + text)
  sink.emit({ type: 'message.delta', messageId, blockIndex: 0, offset: current.length, text })
}

export function emitClaudeBufferedCommentary(
  sink: HarnessConversationDriverSink,
  streamedText: Map<string, string>
): void {
  for (const [id, text] of streamedText) {
    if (!id.endsWith(':reasoning') && text) {
      sink.emit({
        type: 'message.completed',
        message: claudeTextMessage(id, 'assistant', text, 'commentary')
      })
    }
  }
}

export function emitClaudeFinal(
  sink: HarnessConversationDriverSink,
  id: string,
  text: string
): void {
  sink.emit({
    type: 'message.completed',
    message: claudeTextMessage(id, 'assistant', text, 'final')
  })
}

export function parseClaudeQuestions(value: unknown): StructuredProviderInput['questions'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return []
    }
    const question = entry as Record<string, unknown>
    if (typeof question.question !== 'string') {
      return []
    }
    return [
      {
        id: question.question,
        header: typeof question.header === 'string' ? question.header : question.question,
        question: question.question,
        options: Array.isArray(question.options) ? question.options.flatMap(parseOption) : [],
        allowOther: true,
        ...(question.multiSelect === true ? { multiSelect: true } : {})
      }
    ]
  })
}

function parseOption(value: unknown): { label: string; description?: string }[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const option = value as Record<string, unknown>
  return typeof option.label === 'string'
    ? [
        {
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {})
        }
      ]
    : []
}
