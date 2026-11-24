import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  claudeRecord,
  claudeText,
  readClaudeMessageEnvelope
} from './claude-structured-item-translation'

// Stream and final frames have different UUIDs; reconcile by message.id and block order to avoid duplicate rows.

export type ClaudeStreamedTextDelta = {
  identity: AgentJournalItemIdentity
  text: string
  /** Carry producer scope with deltas because checkpoint writes have no envelope. */
  parentToolUseId: string | null
  /** Host time of block start, or first delta if absent; text may arrive seconds later. */
  startedAt: number
}

export type StreamedBlock = { identity: AgentJournalItemIdentity; startedAt: number }

type StreamedMessage = {
  messageId: string | null
  stopped: boolean
  blocks: Map<number, StreamedBlock>
  /** Await final frames in block order for both text and thinking. */
  awaitingFinal: StreamedBlock[]
}

export type ClaudeStreamedBlockRegistry = {
  observe: (frame: Record<string, unknown>, observedAt: number) => ClaudeStreamedTextDelta | null
  reconcile: (frame: {
    sessionId: string
    parentToolUseId: string | null
    messageId: string | null
  }) => StreamedBlock | null
  /** Forget one stream's blocks; other streams keep theirs. */
  clearScope: (sessionId: string, parentToolUseId: string | null) => void
  clear: () => void
}

/** A content block's transcript-stable id: what a streamed row and its saved transcript row share. */
export function claudeSourceBlockId(messageId: string, index: number): string {
  return `block:${messageId}:${index}`
}

export function claudeBlockIsText(block: unknown): boolean {
  return claudeRecord(block)?.type === 'text'
}

/**
 * A CLI older than 2.1 writes one transcript row per content block and leaves off apiBlockIndex.
 * The block order is then the only index it records: the message's own content array, or for a row
 * that holds one block, its position among the parent chain's rows for the same message id.
 */
export function claudeSourceBlockIndex(
  row: Record<string, unknown>,
  chain: readonly Record<string, unknown>[]
): number | null {
  if (typeof row.apiBlockIndex === 'number') {
    return row.apiBlockIndex
  }
  const envelope = readClaudeMessageEnvelope({
    ...row,
    session_id: row.session_id ?? row.sessionId
  })
  if (!envelope?.messageId) {
    return null
  }
  const at = chain.findIndex((entry) => entry.uuid === row.uuid)
  if (at === -1) {
    return null
  }
  let index = 0
  for (let position = at - 1; position >= 0; position -= 1) {
    if (claudeMessageIdOf(chain[position]!) !== envelope.messageId) {
      break
    }
    index += 1
  }
  for (let position = at + 1; position < chain.length; position += 1) {
    if (claudeMessageIdOf(chain[position]!) !== envelope.messageId) {
      break
    }
    index += 1
  }
  return index
}

function claudeMessageIdOf(row: Record<string, unknown>): string | null {
  return (
    readClaudeMessageEnvelope({ ...row, session_id: row.session_id ?? row.sessionId })?.messageId ??
    null
  )
}

function scopeKey(sessionId: string, parentToolUseId: string | null): string {
  return `${sessionId}/${parentToolUseId ?? ''}`
}

export function createClaudeStreamedBlockRegistry(
  blockType: 'text' | 'thinking' = 'text'
): ClaudeStreamedBlockRegistry {
  const messages = new Map<string, StreamedMessage>()

  const messageFor = (scope: string): StreamedMessage => {
    let streamed = messages.get(scope)
    if (!streamed) {
      streamed = { messageId: null, stopped: false, blocks: new Map(), awaitingFinal: [] }
      messages.set(scope, streamed)
    }
    return streamed
  }

  const mint = (
    streamed: StreamedMessage,
    sessionId: string,
    index: number,
    uuid: string,
    startedAt: number
  ): StreamedBlock => {
    const identity: AgentJournalItemIdentity = {
      provider: 'claude',
      sessionId,
      uuid: streamed.messageId ? claudeSourceBlockId(streamed.messageId, index) : uuid
    }
    const block = { identity, startedAt }
    streamed.blocks.set(index, block)
    streamed.awaitingFinal.push(block)
    return block
  }

  return {
    observe: (frame, observedAt) => {
      const event = claudeRecord(frame.event)
      const sessionId = claudeText(frame.session_id)
      const uuid = claudeText(frame.uuid)
      if (frame.type !== 'stream_event' || !event || !sessionId || !uuid) {
        return null
      }
      const parentToolUseId = claudeText(frame.parent_tool_use_id)
      const scope = scopeKey(sessionId, parentToolUseId)
      if (event.type === 'message_start') {
        messages.set(scope, {
          messageId: claudeText(claudeRecord(event.message)?.id),
          stopped: false,
          blocks: new Map(),
          awaitingFinal: []
        })
        return null
      }
      if (event.type === 'message_stop') {
        const streamed = messages.get(scope)
        if (streamed) {
          streamed.stopped = true
          if (streamed.awaitingFinal.length === 0) {
            messages.delete(scope)
          }
        }
        return null
      }
      const index = typeof event.index === 'number' ? event.index : 0
      if (event.type === 'content_block_start') {
        const block = claudeRecord(event.content_block)
        if (block?.type !== blockType) {
          return null
        }
        const started = mint(messageFor(scope), sessionId, index, uuid, observedAt)
        const text = claudeText(block[blockType])
        return text ? { ...started, text, parentToolUseId } : null
      }
      if (event.type !== 'content_block_delta') {
        return null
      }
      const delta = claudeRecord(event.delta)
      const text = delta?.type === `${blockType}_delta` ? claudeText(delta[blockType]) : null
      if (!text) {
        return null
      }
      const streamed = messageFor(scope)
      const started =
        streamed.blocks.get(index) ?? mint(streamed, sessionId, index, uuid, observedAt)
      return { ...started, text, parentToolUseId }
    },
    reconcile: (frame) => {
      const scope = scopeKey(frame.sessionId, frame.parentToolUseId)
      const streamed = messages.get(scope)
      if (
        !streamed ||
        (frame.messageId && streamed.messageId && frame.messageId !== streamed.messageId)
      ) {
        return null
      }
      const block = streamed.awaitingFinal.shift() ?? null
      if (
        streamed.awaitingFinal.length === 0 &&
        (streamed.messageId === null || streamed.stopped)
      ) {
        messages.delete(scope)
      }
      return block
    },
    clearScope: (sessionId, parentToolUseId) => {
      messages.delete(scopeKey(sessionId, parentToolUseId))
    },
    clear: () => messages.clear()
  }
}
