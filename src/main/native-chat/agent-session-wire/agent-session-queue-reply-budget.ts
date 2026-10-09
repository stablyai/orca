import { AGENT_SESSION_QUEUE_REPLY_MAX_BYTES } from '../../../shared/agent-session-queue-pages'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/node-bounded-json-stringify'

export type QueueReplyEnvelope = { id: string; runtimeId: string }
export const LOCAL_QUEUE_REPLY_ENVELOPE: QueueReplyEnvelope = { id: '', runtimeId: '' }

/** The dispatcher uses these exact fields for unary replies, including on the local IPC path. */
export function queueReplyFits(result: unknown, envelope: QueueReplyEnvelope): boolean {
  try {
    stringifyJsonWithinByteLimit(
      { id: envelope.id, ok: true, result, _meta: { runtimeId: envelope.runtimeId } },
      AGENT_SESSION_QUEUE_REPLY_MAX_BYTES
    )
    return true
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return false
    }
    throw error
  }
}

export function boundedQueueReply<T>(result: T, envelope: QueueReplyEnvelope): T {
  if (!queueReplyFits(result, envelope)) {
    throw new Error('Queue reply envelope exceeds its byte budget')
  }
  return result
}
