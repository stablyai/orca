import { applyAppend, replaceList } from '../../../src/shared/native-chat-merge'
import type { NativeChatMerger } from '../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileNativeChatStreamFrame = {
  type?: string
  messages?: NativeChatMessage[]
  hasMore?: boolean
  beforeOffset?: number
  error?: string
  message?: string
}

export type AppliedMobileNativeChatFrame =
  | { kind: 'ignored' }
  | { kind: 'error'; error: string }
  | {
      kind: 'messages'
      messages: NativeChatMessage[]
      hasMore?: boolean
      beforeOffset?: number
      cursorInvalidated?: boolean
      /** The frame replaced the whole retained window (replacement, first
       *  snapshot, or a replay snapshot disjoint from local history) — the
       *  caller must reset its paging window/cursor to the frame's. */
      windowReplaced?: boolean
    }

function replayRetainedTailStart(
  merger: NativeChatMerger,
  messages: readonly NativeChatMessage[],
  hasMore: boolean | undefined
): number | null {
  const firstIndex = messages[0] ? merger.indexById.get(messages[0].id) : undefined
  if (firstIndex === undefined) {
    return null
  }
  // `hasMore: false` is authoritative: retained rows before the replay window
  // were removed while disconnected, even when the newest IDs still match.
  if (hasMore === false && firstIndex > 0) {
    return null
  }
  let expectedIndex = firstIndex
  let sawNewMessage = false
  for (const message of messages) {
    const existingIndex = merger.indexById.get(message.id)
    if (existingIndex === undefined) {
      sawNewMessage = true
    } else if (sawNewMessage || existingIndex !== expectedIndex) {
      return null
    } else {
      expectedIndex += 1
    }
  }
  return expectedIndex === merger.list.length ? firstIndex : null
}

/** Applies runtime stream frames while preserving the initial-snapshot versus
 *  reconnect-replay distinction owned by the session hook. A replay snapshot
 *  that extends a contiguous retained tail merges in by id — paged-in history
 *  survives a socket blip instead of collapsing to the replayed window. A
 *  discontinuous replay (long outage, compaction while away) can't be stitched
 *  without a gap, so it falls back to the fresh authoritative window. */
export function applyMobileNativeChatStreamFrame(args: {
  merger: NativeChatMerger
  frame: MobileNativeChatStreamFrame
  limit: number
  replaceSnapshot: boolean
}): AppliedMobileNativeChatFrame {
  const { merger, frame, limit, replaceSnapshot } = args
  if (frame.type === 'error') {
    return { kind: 'error', error: frame.message ?? frame.error ?? 'Transcript stream failed' }
  }
  if (frame.type !== 'snapshot' && frame.type !== 'replacement' && frame.type !== 'appended') {
    return { kind: 'ignored' }
  }
  if (frame.error) {
    return { kind: 'error', error: frame.error }
  }
  if (!Array.isArray(frame.messages)) {
    return { kind: 'ignored' }
  }
  const replayStartIndex =
    frame.type === 'snapshot' && !replaceSnapshot && merger.list.length > 0
      ? replayRetainedTailStart(merger, frame.messages, frame.hasMore)
      : null
  if (frame.type === 'replacement' || (frame.type === 'snapshot' && replayStartIndex === null)) {
    replaceList(merger, frame.messages)
    return {
      kind: 'messages',
      messages: merger.list,
      hasMore: frame.hasMore,
      windowReplaced: true,
      ...(frame.beforeOffset == null ? {} : { beforeOffset: frame.beforeOffset })
    }
  }
  const previousFirstId = merger.list[0]?.id
  const messages = applyAppend(merger, frame.messages, limit)
  const cursorInvalidated = Boolean(previousFirstId && messages[0]?.id !== previousFirstId)
  const replayStillStartsAtOldest = frame.type === 'snapshot' && replayStartIndex === 0
  return {
    kind: 'messages',
    messages,
    // Why: once the bounded live window drops its oldest row, the snapshot's
    // byte cursor no longer describes the oldest retained message.
    ...(cursorInvalidated ? { cursorInvalidated: true } : {}),
    // A trimmed replay creates page-able history even if the prior window had
    // none; otherwise only a replay sharing our oldest row owns its metadata.
    ...(frame.type === 'snapshot' && cursorInvalidated
      ? { hasMore: true }
      : replayStillStartsAtOldest
        ? {
            ...(frame.hasMore == null ? {} : { hasMore: frame.hasMore }),
            ...(frame.beforeOffset == null ? {} : { beforeOffset: frame.beforeOffset })
          }
        : {})
  }
}
