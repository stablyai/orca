import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EMPTY_NATIVE_CHAT_TRANSCRIPT,
  encodeNativeChatTranscriptIdentity
} from '../../../../src/shared/native-chat/transcript/native-chat-transcript-retention'
import {
  createNativeChatMerger,
  replaceList
} from '../../../../src/shared/native-chat/native-chat-merge'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatSubagentActivity } from '../../../../src/shared/native-chat/input/native-chat-activity'
import { buildNativeChatSubscriptionId } from '../../../../src/shared/native-chat/native-chat-stream-unsubscribe'
import type { RpcClient } from '../../transport/rpc-client'
import {
  applyMobileNativeChatStreamFrame,
  type MobileNativeChatStreamFrame
} from './mobile-native-chat-stream-frame'
import {
  nextMobileNativeChatSubagentSeed,
  type MobileNativeChatSubagentSeed
} from './mobile-native-chat-subagent-seed'
import { useMobileNativeChatSubagentReader } from './input/read-mobile-native-chat-subagent-page'
import type { MobileNativeChatSubagentRead } from './input/use-mobile-native-chat-subagent-page'
import { MAX_MESSAGES, useMobileNativeChatLoadEarlier } from './use-mobile-native-chat-load-earlier'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import { useMobileOlderPageLoader, type OlderPagePhase } from '../use-mobile-older-page-loader'
import {
  cacheMobileNativeChatTranscript,
  mobileNativeChatResumePoint,
  mobileNativeChatTranscriptCache
} from './mobile-native-chat-transcript-cache'

export type MobileNativeChatStatus =
  | 'idle'
  | 'loading'
  | 'waiting-session'
  // No transcript file yet: render the empty chat while keeping its read unsettled.
  | 'awaiting-transcript'
  | 'ready'
  | 'error'

export type MobileNativeChatSession = {
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  // Unsettled reads or passive resets may still hold another tab’s history; wait before interpreting empty messages as a seed/retirement boundary.
  transcriptLoading: boolean
  error?: string
  /** The read failed for good (damage, or a newer Orca's chat): the error says why, once, and
   *  there is nothing to send into. */
  readFailedFinally?: boolean
  hasMore: boolean
  /** `olderPages === 'loading'`, kept because recorded RPC fixtures read it. */
  loadingEarlier: boolean
  olderPages?: OlderPagePhase
  /** Children from history outside the loaded tail. */
  subagentSeed?: readonly NativeChatSubagentActivity[] | null
  readSubagentPage?: MobileNativeChatSubagentRead | null
  loadEarlier: () => void
  /** Latest provider turn boundary from the transcript feed; absent from older hosts. */
  transcriptLifecycle?: NativeChatTurnLifecycle
}

const INITIAL_LIMIT = 40
// Retain paged history across contiguous replay; ordered read windows replace while live appends merge by id.
export function useMobileNativeChatSession(args: {
  client: RpcClient | null
  /** Stable host/workspace source; unlike `client`, it survives manual reconnect. */
  sourceIdentity: string
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
}): MobileNativeChatSession {
  const { client, sourceIdentity, agent, sessionId, transcriptPath } = args
  const [messages, setMessages] = useState<NativeChatMessage[]>([])
  const identity = encodeNativeChatTranscriptIdentity([
    sourceIdentity,
    agent,
    sessionId,
    transcriptPath
  ])
  // Derive pre-read status from props now; a passive effect would lag one commit.
  const initialStatus: MobileNativeChatStatus =
    !client || !agent ? 'idle' : !sessionId ? 'waiting-session' : 'loading'
  // Tag settled outcomes by identity so a switched tab cannot inherit the previous transcript’s verdict.
  const [read, setRead] = useState<{
    client: RpcClient
    identity: string
    status: MobileNativeChatStatus
    // This read failed before it could confirm the cached rows on screen.
    rowsUnconfirmed?: boolean
  } | null>(null)
  // Discard settled state as soon as identity/client changes; view toggles must not revive ready over cleared rows.
  let current = read
  if (current !== null && (current.identity !== identity || current.client !== client)) {
    current = null
    setRead(null)
  }
  // Missing client/agent/session outranks previously settled outcomes.
  const settled = initialStatus === 'loading' ? current : null
  const status = settled ? settled.status : initialStatus
  const [error, setError] = useState<string | undefined>(undefined)
  const [lifecycle, setLifecycle] = useState<{
    identity: string
    lifecycle: NativeChatTurnLifecycle | undefined
  } | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [subagentSeed, setSubagentSeed] = useState<MobileNativeChatSubagentSeed | null>(null)
  const readSubagentPage = useMobileNativeChatSubagentReader({
    client,
    agent,
    sessionId,
    transcriptPath
  })
  const { phase: olderPages, load: loadOlderPages, supersede } = useMobileOlderPageLoader()
  const beforeOffsetRef = useRef<number | null>(null)
  // Cache the id index so live appends cost incoming rows rather than rescanning all history.
  const mergerRef = useRef(createNativeChatMerger())
  const limitRef = useRef(INITIAL_LIMIT)
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId
  // Only the first real snapshot establishes the base; subsequent snapshots are reconnect replays.
  const snapshotSeenRef = useRef(false)
  const settledReady = settled?.status === 'ready'
  useEffect(() => {
    if (settledReady) {
      cacheMobileNativeChatTranscript(identity, {
        messages,
        hasMore,
        beforeOffset: beforeOffsetRef.current
      })
    }
  }, [identity, messages, hasMore, settledReady])

  const setList = useCallback((next: readonly NativeChatMessage[]) => {
    replaceList(mergerRef.current, next)
    setMessages(mergerRef.current.list)
  }, [])

  useEffect(() => {
    let cancelled = false
    // Invalidate pages before early idle/waiting returns can clear their source.
    supersede()
    limitRef.current = INITIAL_LIMIT
    snapshotSeenRef.current = false
    const cached = mobileNativeChatTranscriptCache.get(identity)
    const resumeAfter = cached ? mobileNativeChatResumePoint(cached.messages) : null
    const holdsCachedRows = Boolean(cached?.messages.length)
    setList(cached?.messages ?? EMPTY_NATIVE_CHAT_TRANSCRIPT)
    setError(undefined)
    setHasMore(cached?.hasMore ?? false)
    beforeOffsetRef.current = cached?.beforeOffset ?? null
    if (!client || !agent) {
      return
    }
    if (!sessionId) {
      return
    }

    const unsubscribe = client.subscribe(
      'nativeChat.subscribe',
      {
        agent,
        sessionId,
        limit: limitRef.current,
        // Use a distinct token per screen so another viewer cannot evict this host feed.
        subscriptionId: buildNativeChatSubscriptionId(agent, sessionId, randomV4Uuid()),
        capabilities: { transcriptPending: 1, transcriptSourceOrder: 1, taskList: 1 },
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(resumeAfter ? { resumeAfter } : {})
      },
      (raw) => {
        if (cancelled) {
          return
        }
        const frame = raw as MobileNativeChatStreamFrame
        // No file yet says nothing about rows this subscription already holds: unsettle the read, keep the rows.
        if (resumeAfter && frame.type === 'snapshot' && frame.pending) {
          setRead({ client, identity, status: 'awaiting-transcript' })
          return
        }
        setSubagentSeed((seed) => nextMobileNativeChatSubagentSeed(frame, identity, seed))
        const applied = applyMobileNativeChatStreamFrame({
          merger: mergerRef.current,
          frame,
          // Bound by retained capacity, not the read page, so busy turns cannot drop rows under a scrolled-up reader.
          limit: MAX_MESSAGES,
          replaceSnapshot: !snapshotSeenRef.current
        })
        if (applied.kind === 'ignored') {
          return
        }
        if (applied.kind === 'error') {
          setRead({
            client,
            identity,
            status: 'error',
            rowsUnconfirmed: holdsCachedRows && !snapshotSeenRef.current
          })
          setError(applied.error)
          return
        }
        if (frame.type === 'snapshot' && !applied.pending) {
          // Pending windows establish no transcript base; the next real snapshot must still replace.
          snapshotSeenRef.current = true
        }
        if (
          applied.windowReplaced ||
          (frame.type === 'snapshot' && beforeOffsetRef.current === null)
        ) {
          // Replacement/replay invalidates cursorless pages; cursor pages survive only while their captured window/cursor still match.
          supersede()
        }
        if (applied.windowReplaced) {
          // Keep the grown paging limit for overlapping replays; reset only for fresh windows.
          limitRef.current = INITIAL_LIMIT
          beforeOffsetRef.current = applied.beforeOffset ?? null
          setHasMore(applied.hasMore ?? applied.messages.length >= INITIAL_LIMIT)
        }
        // Snapshots and replacements restate the boundary; appends only advance it.
        if (frame.type === 'appended' ? frame.lifecycle !== undefined : !applied.pending) {
          setLifecycle({ identity, lifecycle: frame.lifecycle })
        }
        setMessages(applied.messages)
        if (!applied.windowReplaced && applied.hasMore != null) {
          setHasMore(applied.hasMore)
        }
        if (!applied.windowReplaced && applied.beforeOffset != null) {
          beforeOffsetRef.current = applied.beforeOffset
        }
        if (applied.cursorInvalidated) {
          // After trimming invalidates the cursor, growing-tail reads avoid gaps behind the retained window.
          supersede()
          beforeOffsetRef.current = null
        }
        setRead({ client, identity, status: applied.pending ? 'awaiting-transcript' : 'ready' })
      }
    )

    return () => {
      cancelled = true
      supersede()
      unsubscribe()
    }
  }, [client, agent, sessionId, transcriptPath, identity, setList, supersede])

  const loadEarlier = useMobileNativeChatLoadEarlier({
    client,
    agent,
    sessionId,
    transcriptPath,
    hasMore,
    setList,
    setHasMore,
    loadOlderPages,
    limitRef,
    mergerRef,
    beforeOffsetRef,
    sessionIdRef
  })

  // Show the cached rows through any unsettled read: a reopen paints at once, and a disconnect or error can't blank the conversation.
  const visibleMessages = settledReady
    ? messages
    : (mobileNativeChatTranscriptCache.get(identity)?.messages ?? EMPTY_NATIVE_CHAT_TRANSCRIPT)

  return {
    // Withhold rows until they belong to this identity; passive reset otherwise exposes previous-tab history for one commit.
    messages: visibleMessages,
    status,
    // Rows left from an earlier visit can't answer "is this ask still open?" until a read confirms them.
    transcriptLoading:
      status === 'loading' || status === 'awaiting-transcript' || settled?.rowsUnconfirmed === true,
    error,
    hasMore,
    loadingEarlier: olderPages === 'loading',
    olderPages,
    subagentSeed: subagentSeed?.identity === identity ? subagentSeed.subagents : undefined,
    readSubagentPage,
    loadEarlier,
    transcriptLifecycle: lifecycle?.identity === identity ? lifecycle.lifecycle : undefined
  }
}
