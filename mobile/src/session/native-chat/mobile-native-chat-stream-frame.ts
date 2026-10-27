import { applyAppend, replaceList } from '../../../../src/shared/native-chat-merge'
import type { NativeChatMerger } from '../../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../../src/shared/native-chat-types'

export type MobileNativeChatStreamFrame = {
  type?: string
  messages?: NativeChatMessage[]
  hasMore?: boolean
  beforeOffset?: number
  // No transcript exists yet; render the empty window without treating it as settled history.
  pending?: boolean
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
      // Reset paging to the frame’s cursor when the retained window is replaced.
      windowReplaced?: boolean
      // Keep the read open until this subscription delivers the real transcript.
      pending?: boolean
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
  // hasMore false proves older retained rows were removed, even if the newest ids still match.
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

// Merge contiguous reconnect replays to retain paged history; gaps/compaction require a fresh authoritative window.
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
  // The subscription owns its token, so an unsolicited end means its feed died.
  if (frame.type === 'end') {
    return { kind: 'error', error: 'Transcript stream ended' }
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
  const pending = frame.type === 'snapshot' && frame.pending === true
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
      ...(pending ? { pending: true } : {}),
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
    ...(pending ? { pending: true } : {}),
    // Trimming the oldest row invalidates the snapshot byte cursor.
    ...(cursorInvalidated ? { cursorInvalidated: true } : {}),
    // Trimmed replays create page-able history; otherwise only a replay sharing our oldest row owns its metadata.
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
