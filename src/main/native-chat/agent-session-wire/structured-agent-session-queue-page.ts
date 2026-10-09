import {
  AGENT_SESSION_QUEUE_PAGE_DEFAULT_SIZE,
  AGENT_SESSION_QUEUE_PAGE_MAX_SIZE,
  type AgentSessionQueuedMessagesPageRequest,
  type AgentSessionQueuedMessagesPageResult,
  type AgentSessionQueuedMessagePreview
} from '../../../shared/agent-session-queue-pages'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuePageRange } from '../agent-session-journal/journal-queued-message-pages'
import {
  boundedQueueReply,
  LOCAL_QUEUE_REPLY_ENVELOPE,
  queueReplyFits,
  type QueueReplyEnvelope
} from './agent-session-queue-reply-budget'
import { queueCursor, readQueuePageCursor } from './agent-session-queue-page-cursor'
import { queuedMessagePreview } from './agent-session-queue-preview'
import { readQueueSummary } from './structured-agent-session-queue-summary'
import type { QueueSendGate } from './structured-agent-session-queued-publication'

export function readQueuedMessagesPage(
  journal: AgentSessionJournal,
  gate: QueueSendGate,
  request: AgentSessionQueuedMessagesPageRequest,
  envelope: QueueReplyEnvelope = LOCAL_QUEUE_REPLY_ENVELOPE
): AgentSessionQueuedMessagesPageResult {
  return journal.queuedMessages.pages.read(() => {
    const store = journal.queuedMessages.pages
    const { generation, revision } = readQueueSummary(journal, gate).queueSummary
    const reset = () =>
      boundedQueueReply({ status: 'stale' as const, generation, revision }, envelope)
    const size = Math.max(
      1,
      Math.min(
        AGENT_SESSION_QUEUE_PAGE_MAX_SIZE,
        request.size ?? AGENT_SESSION_QUEUE_PAGE_DEFAULT_SIZE
      )
    )
    let range: QueuePageRange = { source: request.source, direction: 'after' }
    if (request.cursor) {
      const cursor = readQueuePageCursor(request.cursor)
      if (
        !cursor ||
        cursor.generation !== generation ||
        cursor.sessionId !== request.sessionId ||
        cursor.source !== (request.source ?? null)
      ) {
        return reset()
      }
      const anchor = store.anchor(cursor.messageId, request.source)
      if (!anchor || anchor.position !== cursor.position) {
        return reset()
      }
      range = { source: request.source, direction: cursor.direction, anchor }
    } else if (request.aroundMessageId) {
      const anchor = store.anchor(request.aroundMessageId, request.source)
      if (!anchor) {
        return reset()
      }
      // Why: starting at the requested card guarantees it fits before any preceding backlog.
      range = { source: request.source, direction: 'after', anchor, inclusive: true }
    }
    // Why: two cursors and false flags conservatively budget each row; probe the edges only once.
    const reply = (
      rows: AgentSessionQueuedMessagePreview[],
      probe = false
    ): AgentSessionQueuedMessagesPageResult => {
      const first = rows[0]
      const last = rows.at(-1)
      const before =
        probe && first
          ? store.hasRows({ source: request.source, direction: 'before', anchor: first })
          : false
      const after =
        probe && last
          ? store.hasRows({ source: request.source, direction: 'after', anchor: last })
          : false
      const cursor = (row: AgentSessionQueuedMessagePreview, direction: 'before' | 'after') =>
        queueCursor({
          sessionId: request.sessionId,
          generation,
          source: request.source ?? null,
          position: row.position,
          messageId: row.messageId,
          direction
        })
      return {
        status: 'page',
        generation,
        revision,
        rows,
        hasMore: { before, after },
        previousCursor: (!probe || before) && first ? cursor(first, 'before') : null,
        nextCursor: (!probe || after) && last ? cursor(last, 'after') : null
      }
    }
    let rows: AgentSessionQueuedMessagePreview[] = []
    for (const stored of store.rows(range, size)) {
      const preview = queuedMessagePreview(stored)
      if (!preview) {
        continue
      }
      let row = preview
      const append = () => (range.direction === 'before' ? [row, ...rows] : [...rows, row])
      let candidate = append()
      if (!queueReplyFits(reply(candidate), envelope)) {
        if (rows.length > 0) {
          break
        }
        row = {
          ...row,
          senderLabels: [],
          preview: '',
          truncated: row.truncated || row.preview.length > 0,
          returnedReason: null,
          returnedFailure: undefined
        }
        candidate = append()
      }
      boundedQueueReply(reply(candidate), envelope)
      rows = candidate
    }
    return boundedQueueReply(reply(rows, true), envelope)
  })
}
