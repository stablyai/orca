import type { NativeChatSubagentActivity } from '../../../../src/shared/native-chat/input/native-chat-activity'
import {
  readNativeChatTaskSeedList,
  type NativeChatTaskSeedList
} from '../../../../src/shared/native-chat/input/native-chat-claude-task-updates'
import { readNativeChatSubagentActivities } from '../../../../src/shared/native-chat/input/native-chat-tool-subagents'
import type { NativeChatMerger } from '../../../../src/shared/native-chat/native-chat-merge'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatResumePoint } from '../../../../src/shared/rpc-contract/native-chat-params'
import type { RpcClient } from '../../transport/rpc-client'
import {
  applyMobileNativeChatStreamFrame,
  type MobileNativeChatStreamFrame
} from './mobile-native-chat-stream-frame'

type SubscriptionRead = {
  client: RpcClient
  identity: string
  status: 'awaiting-transcript' | 'error' | 'ready'
  rowsUnconfirmed?: boolean
}

/** Apply one subscribe frame, including the whole-file task seed and a resume that is still pending. */
export function applyMobileNativeChatSubscriptionFrame(args: {
  raw: unknown
  identity: string
  client: RpcClient
  resumeAfter: NativeChatResumePoint | null
  holdsCachedRows: boolean
  merger: NativeChatMerger
  snapshotSeenRef: { current: boolean }
  beforeOffsetRef: { current: number | null }
  limitRef: { current: number }
  initialLimit: number
  maxMessages: number
  setTaskSeed: (
    value: {
      identity: string
      taskList: NativeChatTaskSeedList | null
      subagents: readonly NativeChatSubagentActivity[] | null
    } | null
  ) => void
  setRead: (value: SubscriptionRead) => void
  setError: (value: string | undefined) => void
  setLifecycle: (value: {
    identity: string
    lifecycle: NativeChatTurnLifecycle | undefined
  }) => void
  setMessages: (value: NativeChatMessage[]) => void
  setHasMore: (value: boolean) => void
  supersede: () => void
}): void {
  const frame = args.raw as MobileNativeChatStreamFrame
  if (frame.type === 'task-list') {
    args.setTaskSeed({
      identity: args.identity,
      taskList: readNativeChatTaskSeedList(frame.taskList),
      subagents: readNativeChatSubagentActivities(frame.subagents)
    })
    return
  }
  if (frame.type === 'replacement') {
    args.setTaskSeed(null)
  }
  // No file yet says nothing about rows this subscription already holds: unsettle the read, keep the rows.
  if (args.resumeAfter && frame.type === 'snapshot' && frame.pending) {
    args.setRead({ client: args.client, identity: args.identity, status: 'awaiting-transcript' })
    return
  }
  const applied = applyMobileNativeChatStreamFrame({
    merger: args.merger,
    frame,
    // Bound by retained capacity, not the read page, so busy turns cannot drop rows under a scrolled-up reader.
    limit: args.maxMessages,
    replaceSnapshot: !args.snapshotSeenRef.current
  })
  if (applied.kind === 'ignored') {
    return
  }
  if (applied.kind === 'error') {
    args.setRead({
      client: args.client,
      identity: args.identity,
      status: 'error',
      rowsUnconfirmed: args.holdsCachedRows && !args.snapshotSeenRef.current
    })
    args.setError(applied.error)
    return
  }
  if (frame.type === 'snapshot' && !applied.pending) {
    // Pending windows establish no transcript base; the next real snapshot must still replace.
    args.snapshotSeenRef.current = true
  }
  if (
    applied.windowReplaced ||
    (frame.type === 'snapshot' && args.beforeOffsetRef.current === null)
  ) {
    // Replacement/replay invalidates cursorless pages; cursor pages survive only while their captured window/cursor still match.
    args.supersede()
  }
  if (applied.windowReplaced) {
    // Keep the grown paging limit for overlapping replays; reset only for fresh windows.
    args.limitRef.current = args.initialLimit
    args.beforeOffsetRef.current = applied.beforeOffset ?? null
    args.setHasMore(applied.hasMore ?? applied.messages.length >= args.initialLimit)
  }
  // Snapshots and replacements restate the boundary; appends only advance it.
  if (frame.type === 'appended' ? frame.lifecycle !== undefined : !applied.pending) {
    args.setLifecycle({ identity: args.identity, lifecycle: frame.lifecycle })
  }
  args.setMessages(applied.messages)
  if (!applied.windowReplaced && applied.hasMore != null) {
    args.setHasMore(applied.hasMore)
  }
  if (!applied.windowReplaced && applied.beforeOffset != null) {
    args.beforeOffsetRef.current = applied.beforeOffset
  }
  if (applied.cursorInvalidated) {
    // After trimming invalidates the cursor, growing-tail reads avoid gaps behind the retained window.
    args.supersede()
    args.beforeOffsetRef.current = null
  }
  args.setRead({
    client: args.client,
    identity: args.identity,
    status: applied.pending ? 'awaiting-transcript' : 'ready'
  })
}
