import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type { HarnessConversationDriverSink } from './driver'

export type AcpTextState = Map<string, { role: 'assistant' | 'reasoning'; text: string }>
export type AcpToolState = Map<
  string,
  { name: string; input: unknown; output?: unknown; failed?: boolean }
>
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'

export function acpTextMessage(
  id: string,
  role: 'assistant' | 'reasoning',
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

export function acpTextMessageId(
  role: 'assistant' | 'reasoning',
  messageId: string | null | undefined,
  fallbackMessageId: string
): string {
  return `acp:${role}:${messageId ?? 'message'}:${fallbackMessageId}`
}

export function acpToolMessage(
  toolCallId: string,
  tool: { name: string; input: unknown; output?: unknown; failed?: boolean }
): NativeChatMessage {
  const blocks: NativeChatBlock[] = [
    { type: 'tool-call', toolCallId, name: tool.name, input: tool.input }
  ]
  if (tool.output !== undefined) {
    blocks.push({
      type: 'tool-result',
      toolCallId,
      output: typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output),
      isError: tool.failed
    })
  }
  return {
    id: `acp:tool:${toolCallId}`,
    role: 'tool',
    blocks,
    timestamp: Date.now(),
    source: 'stream'
  }
}

export function emitAcpTool(
  sink: HarnessConversationDriverSink,
  tools: AcpToolState,
  toolCallId: string
): void {
  const tool = tools.get(toolCallId)
  if (tool) {
    sink.emit({ type: 'message.completed', message: acpToolMessage(toolCallId, tool) })
  }
}

export function acpPlanMessage(
  update: Extract<SessionUpdate, { sessionUpdate: 'plan' }>,
  fallbackMessageId: string
): NativeChatMessage {
  const text = update.entries
    .map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`)
    .join('\n')
  return acpTextMessage(`acp:plan:${fallbackMessageId}`, 'reasoning', text)
}

export function acpUsageContext(
  update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>
): AgentSessionContextSnapshot {
  return {
    usedTokens: update.used,
    maxTokens: update.size,
    remainingTokens: Math.max(0, update.size - update.used),
    usedPercent: update.size ? Math.min(100, (update.used / update.size) * 100) : null,
    source: 'provider',
    observedAt: Date.now(),
    compaction: 'idle',
    compactionUpdatedAt: null
  }
}

export function emitAcpTextChunk(
  sink: HarnessConversationDriverSink,
  texts: AcpTextState,
  update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }>,
  fallbackMessageId: string
): void {
  if (update.content.type !== 'text') {
    return
  }
  const role = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
  const id = acpTextMessageId(role, update.messageId, fallbackMessageId)
  const current = texts.get(id)?.text ?? ''
  if (!texts.has(id)) {
    texts.set(id, { role, text: '' })
    sink.emit({ type: 'message.started', message: acpTextMessage(id, role, '') })
  }
  texts.set(id, { role, text: current + update.content.text })
  sink.emit({
    type: 'message.delta',
    messageId: id,
    blockIndex: 0,
    offset: current.length,
    text: update.content.text
  })
}

export function completeAcpReasoning(
  sink: HarnessConversationDriverSink,
  texts: AcpTextState
): void {
  for (const [id, value] of texts) {
    if (value.role === 'reasoning') {
      sink.emit({ type: 'message.completed', message: acpTextMessage(id, 'reasoning', value.text) })
      texts.delete(id)
    }
  }
}

export function flushAcpAssistantCommentary(
  sink: HarnessConversationDriverSink,
  texts: AcpTextState
): void {
  for (const [id, value] of texts) {
    if (value.role === 'assistant') {
      sink.emit({
        type: 'message.completed',
        message: acpTextMessage(id, 'assistant', value.text, 'commentary')
      })
      texts.delete(id)
    }
  }
}

export function completeAcpResponse(
  sink: HarnessConversationDriverSink,
  texts: AcpTextState,
  fallbackMessageId: string,
  assistantPhase?: NativeChatMessage['assistantPhase']
): void {
  for (const [id, value] of texts) {
    if (!id.endsWith(`:${fallbackMessageId}`)) {
      continue
    }
    sink.emit({
      type: 'message.completed',
      message: acpTextMessage(
        id,
        value.role,
        value.text,
        value.role === 'assistant' ? assistantPhase : undefined
      )
    })
    texts.delete(id)
  }
}
