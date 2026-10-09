import {
  AGENT_SESSION_QUEUE_REPLY_MAX_BYTES,
  type AgentSessionQueuedMessageReadRequest,
  type AgentSessionQueuedMessageReadResult
} from '../../../shared/agent-session-queue-pages'
import { getUtf8ChunkEndIndex } from '../../../shared/utf8-byte-limits'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  boundedQueueReply,
  LOCAL_QUEUE_REPLY_ENVELOPE,
  queueReplyFits,
  type QueueReplyEnvelope
} from './agent-session-queue-reply-budget'
import { queueCursor, readQueueBodyCursor } from './agent-session-queue-page-cursor'
import { readQueueSummary } from './structured-agent-session-queue-summary'
import type { QueueSendGate } from './structured-agent-session-queued-publication'

export function readQueuedMessageBody(
  journal: AgentSessionJournal,
  gate: QueueSendGate,
  request: AgentSessionQueuedMessageReadRequest,
  envelope: QueueReplyEnvelope = LOCAL_QUEUE_REPLY_ENVELOPE
): AgentSessionQueuedMessageReadResult {
  return journal.queuedMessages.pages.read(() => {
    const { generation, revision } = readQueueSummary(journal, gate).queueSummary
    const reset = () =>
      boundedQueueReply({ status: 'stale' as const, generation, revision }, envelope)
    const cursor = request.cursor ? readQueueBodyCursor(request.cursor) : null
    if (
      request.cursor &&
      (!cursor ||
        cursor.generation !== generation ||
        cursor.sessionId !== request.sessionId ||
        cursor.messageId !== request.messageId)
    ) {
      return reset()
    }
    const { header, json, bodyBytes } = journal.queuedMessages.pages.body(request.messageId)
    const common = { generation, revision, messageId: request.messageId }
    if (!header || json === null || (header.state !== 'waiting' && header.state !== 'returned')) {
      return boundedQueueReply(
        {
          ...common,
          status: header?.state === 'dispatched' ? ('handed-off' as const) : ('gone' as const)
        },
        envelope
      )
    }
    if (request.expectedState && request.expectedState !== header.state) {
      return boundedQueueReply(
        { ...common, status: 'state-changed' as const, state: header.state },
        envelope
      )
    }
    const offset = cursor?.offset ?? 0
    if (
      (cursor && cursor.fingerprint !== header.fingerprint) ||
      offset >= json.length ||
      splitsSurrogate(json, offset)
    ) {
      return reset()
    }
    const reply = (end: number): AgentSessionQueuedMessageReadResult => ({
      ...common,
      status: 'body',
      state: header.state === 'returned' ? 'returned' : 'waiting',
      bodyBytes,
      part: { offset, json: json.slice(offset, end) },
      nextCursor:
        end < json.length
          ? queueCursor({
              sessionId: request.sessionId,
              generation,
              messageId: request.messageId,
              fingerprint: header.fingerprint,
              offset: end
            })
          : null
    })
    let end = getUtf8ChunkEndIndex(json, offset, AGENT_SESSION_QUEUE_REPLY_MAX_BYTES)
    if (!queueReplyFits(reply(end), envelope)) {
      let low = offset
      let high = end
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (queueReplyFits(reply(middle), envelope)) {
          low = middle
        } else {
          high = middle - 1
        }
      }
      end = splitsSurrogate(json, low) ? low - 1 : low
    }
    if (end <= offset) {
      throw new Error('Queue reply envelope leaves no room for a body part')
    }
    return boundedQueueReply(reply(end), envelope)
  })
}

function splitsSurrogate(text: string, offset: number): boolean {
  const lead = text.charCodeAt(offset - 1)
  const trail = text.charCodeAt(offset)
  return lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff
}
