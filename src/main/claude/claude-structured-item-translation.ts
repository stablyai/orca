import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'

export type ClaudeMessageEnvelope = {
  sessionId: string
  uuid: string
  role: 'assistant' | 'user'
  content: unknown[]
  /** Messages API id shared by every frame of one streamed assistant message. */
  messageId: string | null
  parentToolUseId: string | null
}

export type ClaudeToolUse = { id: string; name: string; input: unknown }
export type ClaudeToolResult = { toolUseId: string; output: string; failed: boolean }

export function claudeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function claudeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readClaudeMessageEnvelope(
  frame: Record<string, unknown>
): ClaudeMessageEnvelope | null {
  if (frame.type !== 'assistant' && frame.type !== 'user') {
    return null
  }
  const message = claudeRecord(frame.message)
  const sessionId = claudeText(frame.session_id)
  const uuid = claudeText(frame.uuid)
  const role = message?.role
  return sessionId && uuid && (role === 'assistant' || role === 'user')
    ? {
        sessionId,
        uuid,
        role,
        content: messageContent(message?.content),
        messageId: claudeText(message?.id),
        parentToolUseId: claudeText(frame.parent_tool_use_id)
      }
    : null
}

// A user replay may carry its text as a bare string (MessageParam), not blocks.
function messageContent(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return content
  }
  const text = claudeText(content)
  return text ? [{ type: 'text', text }] : []
}

export function claudeMessageIdentity(
  envelope: Pick<ClaudeMessageEnvelope, 'sessionId' | 'uuid'>
): AgentJournalItemIdentity {
  return { provider: 'claude', sessionId: envelope.sessionId, uuid: envelope.uuid }
}

function messageBlocks(envelope: ClaudeMessageEnvelope): NativeChatBlock[] {
  const blocks: NativeChatBlock[] = []
  for (const value of envelope.content) {
    const part = claudeRecord(value)
    const text = claudeText(part?.text)
    if (part?.type === 'text' && text) {
      blocks.push({ type: 'text', text })
      continue
    }
    const source = claudeRecord(part?.source)
    const url = claudeText(source?.url)
    if (part?.type === 'image' && source?.type === 'url' && url) {
      blocks.push({ type: 'image-ref', url })
    }
  }
  return blocks
}

export function claudeMessageBody(envelope: ClaudeMessageEnvelope): AgentJournalMessageItem | null {
  const blocks = messageBlocks(envelope)
  return blocks.length > 0 ? { kind: 'message', role: envelope.role, blocks } : null
}

export function claudeHasReplayContent(envelope: ClaudeMessageEnvelope): boolean {
  return envelope.content.some((value) => {
    const part = claudeRecord(value)
    return part !== null && part.type !== 'tool_result'
  })
}

export function claudeToolUses(envelope: ClaudeMessageEnvelope): ClaudeToolUse[] {
  return envelope.content.flatMap((value) => {
    const part = claudeRecord(value)
    const id = claudeText(part?.id)
    const name = claudeText(part?.name)
    return part?.type === 'tool_use' && id && name ? [{ id, name, input: part.input ?? null }] : []
  })
}

function resultText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return value === undefined ? '' : JSON.stringify(value)
  }
  return value
    .flatMap((entry) => {
      if (typeof entry === 'string') {
        return [entry]
      }
      const part = claudeRecord(entry)
      return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    })
    .join('\n')
}

export function claudeToolResults(envelope: ClaudeMessageEnvelope): ClaudeToolResult[] {
  return envelope.content.flatMap((value) => {
    const part = claudeRecord(value)
    const toolUseId = claudeText(part?.tool_use_id)
    return part?.type === 'tool_result' && toolUseId
      ? [
          {
            toolUseId,
            output: resultText(part.content),
            failed: part.is_error === true
          }
        ]
      : []
  })
}

export function claudeThinkingText(envelope: ClaudeMessageEnvelope): string | null {
  const parts = envelope.content.flatMap((value) => {
    const part = claudeRecord(value)
    const thinking = claudeText(part?.thinking)
    return part?.type === 'thinking' && thinking ? [thinking] : []
  })
  return parts.length > 0 ? parts.join('\n') : null
}

export function claudeToolBody(input: {
  tool: ClaudeToolUse
  result?: ClaudeToolResult
}): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name: input.tool.name,
    input: input.tool.input,
    state: input.result ? (input.result.failed ? 'failed' : 'completed') : 'running',
    ...(input.result
      ? { output: boundInlineText(input.result.output, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded }
      : {})
  }
}

export function claudeStreamingMessageBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

export function claudeToolIdentity(sessionId: string, toolUseId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `claude-tool:${sessionId}:${toolUseId}` }
}

export function claudeThinkingIdentity(sessionId: string, uuid: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `claude-thinking:${sessionId}:${uuid}` }
}
