import { createRetainedBytesBudget, observeRetainedBytes } from '../../memory/retained-bytes-budget'

/**
 * Serialized bytes main may hold for chats between producers and the consumers that haven't
 * taken them yet. A payload budget, not a heap bound: decoded objects cost more than this counts.
 */
export const CHAT_PATH_RETAINED_BYTES = 256 * 2 ** 20
/** Live text waiting behind subscriber deliveries; each shared snapshot is charged once. */
export const CHAT_LIVE_TEXT_RETAINED_BYTES = 128 * 2 ** 20
/** One subscriber's live text being delivered plus waiting; past it, that stream ends itself. */
export const CHAT_LIVE_TEXT_SUBSCRIBER_BYTES = 8 * 2 ** 20

export const chatPathRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_PATH_RETAINED_BYTES
})
export const chatLiveTextRetainedBytes = createRetainedBytesBudget({
  maxBytes: CHAT_LIVE_TEXT_RETAINED_BYTES,
  parent: chatPathRetainedBytes
})

observeRetainedBytes('live', chatLiveTextRetainedBytes.reading)

/** A rough per-value cost on top of string characters; keeps tiny values from counting as free. */
const VALUE_BYTES = 16
const sizes = new WeakMap<object, number>()

/**
 * Estimates what a payload holds on the heap: two bytes per character plus a fixed cost per value.
 * One visit per value and no serialization, so a growing reply costs its value count, not its
 * length; measured once per payload however many holders share it. A string sliced from a larger
 * one would keep more alive, but live text is parsed provider output, never such a slice.
 */
export function heldBytesOf(payload: object): number {
  const cached = sizes.get(payload)
  if (cached !== undefined) {
    return cached
  }
  let bytes = 0
  const stack: unknown[] = [payload]
  while (stack.length > 0) {
    const value = stack.pop()
    bytes += VALUE_BYTES
    if (typeof value === 'string') {
      bytes += value.length * 2
    } else if (Array.isArray(value)) {
      for (const child of value) {
        stack.push(child)
      }
    } else if (value && typeof value === 'object') {
      for (const key in value) {
        bytes += key.length * 2
        stack.push(Reflect.get(value, key))
      }
    }
  }
  sizes.set(payload, bytes)
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
    const release = chatLiveTextRetainedBytes.claim(heldBytesOf(payload))
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
