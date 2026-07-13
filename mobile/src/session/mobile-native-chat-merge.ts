import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { NATIVE_CHAT_SOURCE_PRIORITY } from './mobile-native-chat-blocks'

// Why: the host streams the whole transcript on the first drain and only
// appended turns afterwards, and the offset-0 re-read can re-emit a turn that
// was already in the snapshot. So mobile merges batches by message id rather
// than concatenating — re-emitted ids replace in place (no dup, no drop),
// preserving first-seen order so the list stays stable as turns stream in.
//
// This is a parity-locked twin of src/shared/native-chat-merge.ts: Metro can't
// resolve runtime values outside the mobile package, so the algorithm is
// duplicated here and pinned to the renderer copy by the cross-surface parity
// test (mobile-native-chat-merge-parity.test.ts). Keep the two bodies in sync.

/** Merge a batch of incoming messages into the existing ordered list, deduping
 *  by `id`. An incoming message replaces an existing one of the same id only
 *  when its source is at least as authoritative (transcript > hook > scrape),
 *  mirroring the desktop assembler's precedence. New ids append in arrival
 *  order. Returns a new array; never mutates the input. */
export function mergeNativeChatMessages(
  existing: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return existing as NativeChatMessage[]
  }
  const merged = [...existing]
  const indexById = new Map<string, number>()
  merged.forEach((message, index) => indexById.set(message.id, index))
  applyIncoming(merged, indexById, incoming)
  return merged
}

/** Cap a message list to its most-recent `limit` entries; the base read is
 *  already windowed, so this bounds the live-append tail to the same window.
 *  Mirrors boundNativeChatWindow in src/shared/native-chat-merge.ts. */
export function boundNativeChatWindow(
  messages: readonly NativeChatMessage[],
  limit: number
): NativeChatMessage[] {
  if (limit <= 0 || messages.length <= limit) {
    return messages as NativeChatMessage[]
  }
  return messages.slice(messages.length - limit)
}

/** Stateful id-dedup merger that caches the id→index map across appends so a
 *  streaming run pays O(incoming) per frame instead of O(existing+incoming)
 *  (#18). `replaceList` resets the cache for a new base (initial read /
 *  loadEarlier); `applyAppend` folds a live batch in. Output equals the pure
 *  `mergeNativeChatMessages` for every input. */
export type NativeChatMerger = {
  list: NativeChatMessage[]
  readonly indexById: Map<string, number>
}

export function createNativeChatMerger(): NativeChatMerger {
  return { list: [], indexById: new Map() }
}

export function replaceList(merger: NativeChatMerger, list: readonly NativeChatMessage[]): void {
  merger.list = [...list]
  merger.indexById.clear()
  merger.list.forEach((message, index) => merger.indexById.set(message.id, index))
}

export function applyAppend(
  merger: NativeChatMerger,
  incoming: readonly NativeChatMessage[],
  limit?: number
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return merger.list
  }
  const next = [...merger.list]
  applyIncoming(next, merger.indexById, incoming)
  const bounded = limit == null ? next : boundNativeChatWindow(next, limit)
  if (bounded !== next) {
    // Trimming shifts every index, so rebuild the cached map once at the window
    // boundary rather than retaining stale positions into discarded history.
    replaceList(merger, bounded)
    return merger.list
  }
  merger.list = next
  return next
}

// Shared inner loop: one id-dedup + precedence rule for both the pure function
// and the stateful merger, so the two can never drift within this bundle.
function applyIncoming(
  list: NativeChatMessage[],
  indexById: Map<string, number>,
  incoming: readonly NativeChatMessage[]
): void {
  for (const message of incoming) {
    const at = indexById.get(message.id)
    if (at === undefined) {
      indexById.set(message.id, list.length)
      list.push(message)
      continue
    }
    const current = list[at]!
    if (
      NATIVE_CHAT_SOURCE_PRIORITY[message.source] >= NATIVE_CHAT_SOURCE_PRIORITY[current.source]
    ) {
      list[at] = message
    }
  }
}
