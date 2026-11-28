import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import { ownRetainedString } from '../../../../shared/text/own-retained-string'

// Stream and final frames have different UUIDs; reconcile by message.id and block order to avoid duplicate rows.

export type ClaudeStreamedTextDelta = {
  identity: AgentJournalItemIdentity
  text: string
  /** Carry producer scope with deltas because checkpoint writes have no envelope. */
  parentToolUseId: string | null
  /** Host time of block start, or first delta if absent; text may arrive seconds later. */
  startedAt: number
}

export type StreamedBlock = {
  identity: AgentJournalItemIdentity
  startedAt: number
  index: number
  /** A relay continuation's own row, which its final frame retires (see `reconcile`). */
  retired?: AgentJournalItemIdentity
}

/** On a stream line, the relay continuation a cut replay moved its message to. */
export const CLAUDE_RELAY_CONTINUATION_KEY = 'orca_relay_continuation'

/** `blank` holds the tail of a text block's whitespace until visible text shows. */
type OpenBlock = StreamedBlock & { awaited: boolean; blank: string }

type StreamedMessage = {
  messageId: string | null
  /** The message's start was cut from a replay: it streams under a continuation id. */
  continuation: boolean
  stopped: boolean
  blocks: Map<number, OpenBlock>
  /** Await final frames in block order for both text and thinking. */
  awaitingFinal: OpenBlock[]
}

export type ClaudeStreamedBlockRegistry = {
  observe: (frame: Record<string, unknown>, observedAt: number) => ClaudeStreamedTextDelta | null
  reconcile: (frame: {
    sessionId: string
    parentToolUseId: string | null
    messageId: string | null
  }) => StreamedBlock | null
  /** A continuation's final with no streamed block (the cut fell after its last delta) is saved
   *  under its own id; the stream's next `content_block_stop` names the saved row to move it to. */
  holdUnplaced: (
    frame: { sessionId: string; parentToolUseId: string | null; messageId: string },
    place: (row: AgentJournalItemIdentity) => void
  ) => void
  /** Places a held final at this stream frame's block stop; dropped at its message's boundary. */
  placeAt: (frame: Record<string, unknown>) => boolean
  /** Forget one stream's blocks; other streams keep theirs. */
  clearScope: (sessionId: string, parentToolUseId: string | null) => void
  clear: () => void
}

/** A content block's transcript-stable id: what a streamed row and its saved transcript row share. */
export function claudeSourceBlockId(messageId: string, index: number): string {
  return `block:${messageId}:${index}`
}

// Only the whitespace just before the text can indent it, so a short tail is enough.
const HELD_BLANK_LIMIT = 256

function scopeKey(sessionId: string, parentToolUseId: string | null): string {
  return `${sessionId}/${parentToolUseId ?? ''}`
}

export function createClaudeStreamedBlockRegistry(
  blockType: 'text' | 'thinking' = 'text'
): ClaudeStreamedBlockRegistry {
  const messages = new Map<string, StreamedMessage>()
  const unplaced = new Map<
    string,
    { messageId: string; place: (row: AgentJournalItemIdentity) => void }
  >()

  const messageFor = (scope: string, frame: Record<string, unknown>): StreamedMessage => {
    let streamed = messages.get(scope)
    if (!streamed) {
      const continuation = claudeText(frame[CLAUDE_RELAY_CONTINUATION_KEY])
      streamed = {
        messageId: continuation,
        continuation: continuation !== null,
        stopped: false,
        blocks: new Map(),
        awaitingFinal: []
      }
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
  ): OpenBlock => {
    const identity: AgentJournalItemIdentity = {
      provider: 'claude',
      sessionId,
      uuid: streamed.messageId ? claudeSourceBlockId(streamed.messageId, index) : uuid
    }
    const block = { identity, startedAt, index, awaited: false, blank: '' }
    streamed.blocks.set(index, block)
    return block
  }

  // Claude Code sends no final frame for a blank text block, so it gets no row until text shows.
  const shownText = (streamed: StreamedMessage, block: OpenBlock, text: string): string | null => {
    if (block.awaited) {
      return text
    }
    if (blockType === 'text' && !/\S/.test(text)) {
      block.blank = ownRetainedString(
        (block.blank + text.slice(-HELD_BLANK_LIMIT)).slice(-HELD_BLANK_LIMIT)
      )
      return null
    }
    block.awaited = true
    streamed.awaitingFinal.push(block)
    const shown = block.blank + text
    block.blank = ''
    return shown
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
          continuation: false,
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
        const streamed = messageFor(scope, frame)
        const started = mint(streamed, sessionId, index, uuid, observedAt)
        const text = shownText(streamed, started, claudeText(block[blockType]) ?? '')
        return text
          ? { identity: started.identity, startedAt: started.startedAt, text, parentToolUseId }
          : null
      }
      if (event.type !== 'content_block_delta') {
        return null
      }
      const delta = claudeRecord(event.delta)
      const text = delta?.type === `${blockType}_delta` ? claudeText(delta[blockType]) : null
      if (!text) {
        return null
      }
      const streamed = messageFor(scope, frame)
      const started =
        streamed.blocks.get(index) ?? mint(streamed, sessionId, index, uuid, observedAt)
      const shown = shownText(streamed, started, text)
      return shown
        ? { identity: started.identity, startedAt: started.startedAt, text: shown, parentToolUseId }
        : null
    },
    reconcile: (frame) => {
      const scope = scopeKey(frame.sessionId, frame.parentToolUseId)
      const streamed = messages.get(scope)
      // A continuation's final names the real message: it goes on the row saved before the cut.
      const moved = streamed?.continuation === true && frame.messageId !== null
      if (
        !streamed ||
        (!moved && frame.messageId && streamed.messageId && frame.messageId !== streamed.messageId)
      ) {
        return null
      }
      const shifted = streamed.awaitingFinal.shift() ?? null
      const block =
        moved && shifted && frame.messageId
          ? {
              ...shifted,
              identity: {
                provider: 'claude' as const,
                sessionId: frame.sessionId,
                uuid: claudeSourceBlockId(frame.messageId, shifted.index)
              },
              retired: shifted.identity
            }
          : shifted
      if (
        streamed.awaitingFinal.length === 0 &&
        (streamed.messageId === null || streamed.stopped)
      ) {
        messages.delete(scope)
      }
      return block
    },
    holdUnplaced: (frame, place) => {
      unplaced.set(scopeKey(frame.sessionId, frame.parentToolUseId), {
        messageId: frame.messageId,
        place
      })
    },
    placeAt: (frame) => {
      const sessionId = claudeText(frame.session_id)
      const event = claudeRecord(frame.event)
      if (unplaced.size === 0 || frame.type !== 'stream_event' || !event || !sessionId) {
        return false
      }
      const scope = scopeKey(sessionId, claudeText(frame.parent_tool_use_id))
      const held = unplaced.get(scope)
      if (held && event.type !== 'content_block_delta') {
        unplaced.delete(scope)
      }
      if (!held || event.type !== 'content_block_stop' || typeof event.index !== 'number') {
        return false
      }
      held.place({
        provider: 'claude',
        sessionId,
        uuid: claudeSourceBlockId(held.messageId, event.index)
      })
      return true
    },
    clearScope: (sessionId, parentToolUseId) => {
      messages.delete(scopeKey(sessionId, parentToolUseId))
      unplaced.delete(scopeKey(sessionId, parentToolUseId))
    },
    clear: () => {
      messages.clear()
      unplaced.clear()
    }
  }
}
