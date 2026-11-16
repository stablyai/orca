import { describeWorkerMessage } from '../../worker-threads/worker-message-shape'
import { createRetainedBytesBudget, observeRetainedBytes } from '../../memory/retained-bytes-budget'

/** Everything main holds for chats between producers and consumers that have not taken it. */
export const CHAT_PATH_RETAINED_BYTES = 256 * 2 ** 20
/** Live text waiting behind subscriber deliveries, at most two snapshots per subscriber. */
export const CHAT_LIVE_TEXT_RETAINED_BYTES = 128 * 2 ** 20
/** Chat frames sent to renderers that have not acknowledged them. */
export const CHAT_RENDERER_RETAINED_BYTES = 192 * 2 ** 20

export const chatPathRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_PATH_RETAINED_BYTES
})
export const chatLiveTextRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_LIVE_TEXT_RETAINED_BYTES,
  parent: chatPathRetainedBytes
})
export const chatRendererRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_RENDERER_RETAINED_BYTES,
  parent: chatPathRetainedBytes
})

observeRetainedBytes('live', chatLiveTextRetainedBytes.reading)
observeRetainedBytes('frames', chatRendererRetainedBytes.reading)

/**
 * Never below the structured-clone size: the bounded walk counts characters, which a two-byte
 * string clones at twice. A walk cut short counts what it reached.
 */
export function retainedBytesOf(value: unknown): number {
  return describeWorkerMessage(value).bytes * 2
}

let refusals = 0

/** Streams ended rather than exceed the chat budget since launch. */
export function chatRetainedBytesRefusals(): number {
  return refusals
}

export function noteChatRetainedBytesRefused(): void {
  refusals += 1
}

/** A holder ended its stream rather than exceed the chat budget; the client resumes from its cursor. */
export class ChatRetainedBytesRefused extends Error {
  constructor(holder: string) {
    super(`${holder} would exceed the chat memory budget`)
    this.name = 'ChatRetainedBytesRefused'
  }
}
