import {
  AGENT_SESSION_QUEUE_PREVIEW_MAX_BYTES,
  type AgentSessionQueuedMessagePreview,
  type AgentSessionQueueSource
} from '../../../shared/agent-session-queue-pages'
import { readAgentMessageSource } from '../../../shared/agent-session-message-source'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'
import { clampUtf8TextPrefix } from '../../../shared/utf8-byte-limits'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'

export function queuedMessagePreview(input: {
  row: QueuedMessageRow
  source: AgentSessionQueueSource
  bodyBytes: number
}): AgentSessionQueuedMessagePreview | null {
  const { row, source, bodyBytes } = input
  if (row.state !== 'waiting' && row.state !== 'returned') {
    return null
  }
  let preview = ''
  let truncated = false
  for (const block of row.body.blocks) {
    if (block.type !== 'text') {
      continue
    }
    const full = preview + (preview ? '\n' : '') + block.text
    preview = clampUtf8TextPrefix(full, AGENT_SESSION_QUEUE_PREVIEW_MAX_BYTES)
    if (preview !== full) {
      truncated = true
      break
    }
  }
  const senders = readAgentMessageSource(row.body.from)?.senders ?? []
  const paused = row.state === 'waiting' && row.holdReason !== null
  return {
    messageId: row.messageId,
    position: row.position,
    state: row.state,
    ...(paused ? { paused: true as const } : {}),
    ...(paused && row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
      ? { pausedReason: row.holdReason }
      : {}),
    ...(row.state === 'returned'
      ? {
          returnedReason:
            row.returnedReason === null ? null : clampUtf8TextPrefix(row.returnedReason, 512),
          ...(row.returnedRejection
            ? { returnedFailure: { kind: clampUtf8TextPrefix(row.returnedRejection.kind, 128) } }
            : {})
        }
      : {}),
    source,
    senderLabels: senders
      .slice(0, 3)
      .map((sender) => clampUtf8TextPrefix(sender.name ?? sender.party.address, 128)),
    senderCount: senders.length,
    preview,
    truncated,
    bodyBytes
  }
}
