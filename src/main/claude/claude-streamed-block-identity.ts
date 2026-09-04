import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

// Under --include-partial-messages every stream_event frame carries its own
// uuid, and the block's final `assistant` frame carries yet another; only
// `message.id` ties them together. The block's first stream frame mints the
// journal identity, and the final frame lands on it in block order instead of
// appending a duplicate under its own uuid.

export type ClaudeStreamedTextDelta = { identity: AgentJournalItemIdentity; text: string }

type StreamedMessage = {
  messageId: string | null
  blocks: Map<number, AgentJournalItemIdentity>
  /** Streamed text blocks whose final assistant frame has not arrived, in block order. */
  awaitingFinal: AgentJournalItemIdentity[]
}

export type ClaudeStreamedBlockRegistry = {
  /** Text a stream_event frame appends to its block, or null when it carries none. */
  observe: (frame: Record<string, unknown>) => ClaudeStreamedTextDelta | null
  /** The streamed identity a final assistant frame reconciles onto, if its block streamed. */
  reconcile: (frame: {
    sessionId: string
    parentToolUseId: string | null
    messageId: string | null
  }) => AgentJournalItemIdentity | null
  clear: () => void
}

function scopeKey(sessionId: string, parentToolUseId: string | null): string {
  return `${sessionId}/${parentToolUseId ?? ''}`
}

export function createClaudeStreamedBlockRegistry(): ClaudeStreamedBlockRegistry {
  const messages = new Map<string, StreamedMessage>()

  const messageFor = (scope: string): StreamedMessage => {
    let streamed = messages.get(scope)
    if (!streamed) {
      streamed = { messageId: null, blocks: new Map(), awaitingFinal: [] }
      messages.set(scope, streamed)
    }
    return streamed
  }

  const mint = (
    streamed: StreamedMessage,
    sessionId: string,
    index: number,
    uuid: string
  ): AgentJournalItemIdentity => {
    const identity: AgentJournalItemIdentity = { provider: 'claude', sessionId, uuid }
    streamed.blocks.set(index, identity)
    streamed.awaitingFinal.push(identity)
    return identity
  }

  return {
    observe: (frame) => {
      const event = claudeRecord(frame.event)
      const sessionId = claudeText(frame.session_id)
      const uuid = claudeText(frame.uuid)
      if (frame.type !== 'stream_event' || !event || !sessionId || !uuid) {
        return null
      }
      const scope = scopeKey(sessionId, claudeText(frame.parent_tool_use_id))
      if (event.type === 'message_start') {
        messages.set(scope, {
          messageId: claudeText(claudeRecord(event.message)?.id),
          blocks: new Map(),
          awaitingFinal: []
        })
        return null
      }
      const index = typeof event.index === 'number' ? event.index : 0
      if (event.type === 'content_block_start') {
        const block = claudeRecord(event.content_block)
        if (block?.type !== 'text') {
          return null
        }
        const identity = mint(messageFor(scope), sessionId, index, uuid)
        const text = claudeText(block.text)
        return text ? { identity, text } : null
      }
      if (event.type !== 'content_block_delta') {
        return null
      }
      const delta = claudeRecord(event.delta)
      const text = delta?.type === 'text_delta' ? claudeText(delta.text) : null
      if (!text) {
        return null
      }
      const streamed = messageFor(scope)
      const identity = streamed.blocks.get(index) ?? mint(streamed, sessionId, index, uuid)
      return { identity, text }
    },
    reconcile: (frame) => {
      const streamed = messages.get(scopeKey(frame.sessionId, frame.parentToolUseId))
      if (
        !streamed ||
        (frame.messageId && streamed.messageId && frame.messageId !== streamed.messageId)
      ) {
        return null
      }
      return streamed.awaitingFinal.shift() ?? null
    },
    clear: () => messages.clear()
  }
}
