import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** One subscriber's live text being delivered plus waiting; past it, that stream ends itself. */
export const CHAT_LIVE_TEXT_SUBSCRIBER_BYTES = 8 * 2 ** 20

/** A rough per-value cost on top of string characters; keeps tiny values from counting as free. */
const VALUE_BYTES = 16
const sizes = new WeakMap<object, number>()

/**
 * Estimates what a payload holds on the heap: two bytes per character plus a fixed cost per value.
 * One visit per value and no serialization, so a growing reply costs its value count, not its
 * length; measured once per payload however many holders share it. A string sliced from a larger
 * one would keep more alive, but live text is parsed provider output, never such a slice.
 */
export function heldBytesOf(payload: readonly AgentJournalRenderItem[]): number {
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
      for (const [key, child] of Object.entries(value)) {
        bytes += key.length * 2
        stack.push(child)
      }
    }
  }
  sizes.set(payload, bytes)
  return bytes
}

let capped = 0

/** Streams ended at their live-text cap since launch. */
export function liveTextCapReachedCount(): number {
  return capped
}

export function noteLiveTextCapReached(): void {
  capped += 1
}

/** A stream ended at its live-text cap; the client resumes from its cursor. */
export class SubscriberLiveTextCapReached extends Error {
  constructor() {
    super('subscriber live text would exceed its memory cap')
    this.name = 'SubscriberLiveTextCapReached'
  }
}
