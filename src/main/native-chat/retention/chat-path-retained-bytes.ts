import { createRetainedBytesBudget, observeRetainedBytes } from '../../memory/retained-bytes-budget'

/**
 * Serialized bytes main may hold for chats between producers and the consumers that haven't
 * taken them yet. A payload budget, not a heap bound: decoded objects cost more than this counts.
 */
export const CHAT_PATH_RETAINED_BYTES = 256 * 2 ** 20
/** Live text waiting behind subscriber deliveries; each shared snapshot is charged once. */
export const CHAT_LIVE_TEXT_RETAINED_BYTES = 128 * 2 ** 20

export const chatPathRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_PATH_RETAINED_BYTES
})
export const chatLiveTextRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_LIVE_TEXT_RETAINED_BYTES,
  parent: chatPathRetainedBytes
})

observeRetainedBytes('live', chatLiveTextRetainedBytes.reading)

const sizes = new WeakMap<object, number>()

/** Exact serialized size, measured once per immutable payload however many holders share it. */
export function serializedBytesOf(payload: object): number {
  let bytes = sizes.get(payload)
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(payload) ?? '')
    sizes.set(payload, bytes)
  }
  return bytes
}

const shared = new WeakMap<object, { holders: number; release: () => void }>()

/**
 * Charges a live-text snapshot once while any subscriber holds it, released after the last.
 * Null when the chat budget is full: the holder ends its stream and the client resumes.
 */
export function claimSharedLiveText(payload: object): (() => void) | null {
  let claim = shared.get(payload)
  if (!claim) {
    const release = chatLiveTextRetainedBytes.claim(serializedBytesOf(payload))
    if (!release) {
      return null
    }
    claim = { holders: 0, release }
    shared.set(payload, claim)
  }
  const held = claim
  held.holders += 1
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    held.holders -= 1
    if (held.holders === 0) {
      shared.delete(payload)
      held.release()
    }
  }
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
