import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from '../../../src/shared/native-chat/transcript/native-chat-transcript-retention'
import { createNativeChatMerger, replaceList } from '../../../src/shared/native-chat-merge'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../src/shared/native-chat-types'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat/native-chat-stream-unsubscribe'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatSessionPageRead } from './mobile-session-read-operations'
import {
  applyMobileNativeChatStreamFrame,
  type MobileNativeChatStreamFrame
} from './native-chat/mobile-native-chat-stream-frame'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { useMobileOlderPageLoader, type OlderPagePhase } from './use-mobile-older-page-loader'

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
  loadEarlier: () => void
  /** Latest provider turn boundary from the transcript feed; absent from older hosts. */
  transcriptLifecycle?: NativeChatTurnLifecycle
}

const INITIAL_LIMIT = 40
const PAGE = 60
const MAX_MESSAGES = 2000

function nextPageWindow(
  limit: number,
  listLength: number
): { nextLimit: number; pageLimit: number } | null {
  // Live output grows the list past the last read, so the next page counts from what is held.
  const held = Math.max(limit, listLength)
  const nextLimit = Math.min(held + PAGE, MAX_MESSAGES)
  return nextLimit > held ? { nextLimit, pageLimit: nextLimit - held } : null
}

type ReadSessionResult =
  | { messages: NativeChatMessage[]; hasMore?: boolean; beforeOffset?: number }
  | { error: string }
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
  const { phase: olderPages, load: loadOlderPages, supersede } = useMobileOlderPageLoader()
  const beforeOffsetRef = useRef<number | null>(null)
  // Cache the id index so live appends cost incoming rows rather than rescanning all history.
  const mergerRef = useRef(createNativeChatMerger())
  const limitRef = useRef(INITIAL_LIMIT)
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId
  // Only the first real snapshot establishes the base; subsequent snapshots are reconnect replays.
  const snapshotSeenRef = useRef(false)
  const transcriptRetentionRef = useRef(createNativeChatTranscriptRetention())
  const settledReady = settled?.status === 'ready'
  useEffect(() => {
    if (settledReady) {
      transcriptRetentionRef.current.capture(identity, messages)
    }
  }, [identity, messages, settledReady])

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
    setList([])
    setError(undefined)
    setHasMore(false)
    beforeOffsetRef.current = null
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
        capabilities: { transcriptPending: 1, transcriptSourceOrder: 1 },
        ...(transcriptPath ? { transcriptPath } : {})
      },
      (raw) => {
        if (cancelled) {
          return
        }
        const frame = raw as MobileNativeChatStreamFrame
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
          setRead({ client, identity, status: 'error' })
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

  const loadEarlier = useCallback(() => {
    if (!client || !agent || !sessionId || !hasMore) {
      return
    }
    // Capture the page’s session so late replies cannot land in a newly selected chat.
    const requestSessionId = sessionId
    loadOlderPages(async ({ timeoutMs, isCurrent }) => {
      const page = nextPageWindow(limitRef.current, mergerRef.current.list.length)
      if (!page) {
        setHasMore(false)
        return 'end'
      }
      const { nextLimit, pageLimit } = page
      const beforeOffset = beforeOffsetRef.current
      const response = await nativeChatSessionPageRead.request(
        client,
        {
          agent,
          sessionId,
          limit: beforeOffset === null ? nextLimit : pageLimit,
          capabilities: { transcriptSourceOrder: 1 },
          ...(beforeOffset === null ? {} : { beforeOffset }),
          ...(transcriptPath ? { transcriptPath } : {})
        },
        { timeoutMs, budgetSpansConnect: true }
      )
      const accepted = nativeChatSessionPageRead.interpret(response)
      if (!accepted.accepted) {
        return 'failed'
      }
      // Accepted legacy-union replies may be absent/null; validate before using the in operator.
      const payload = accepted.value
      if (payload === null || typeof payload !== 'object') {
        return 'failed'
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main cast this payload unread; the reader hands back the same result.
      const result = payload as ReadSessionResult
      if ('error' in result) {
        return 'failed'
      }
      // Apply pages only to their captured window/cursor; otherwise retry from the new window.
      if (
        !isCurrent() ||
        sessionIdRef.current !== requestSessionId ||
        beforeOffsetRef.current !== beforeOffset
      ) {
        return 'end'
      }
      limitRef.current = nextLimit
      let more: boolean
      if (beforeOffset !== null && result.beforeOffset != null) {
        beforeOffsetRef.current = result.beforeOffset
        setList([...result.messages, ...mergerRef.current.list])
        more = nextLimit < MAX_MESSAGES && (result.hasMore ?? result.messages.length >= pageLimit)
      } else {
        // Legacy hosts return a growing tail instead of cursor pages; preserve rows streamed during the read.
        const live = mergerRef.current.list
        const after = live.findIndex((message) => message.id === result.messages.at(-1)?.id)
        setList(after === -1 ? result.messages : [...result.messages, ...live.slice(after + 1)])
        more = result.messages.length >= nextLimit
      }
      setHasMore(more)
      return more ? 'drew' : 'end'
    })
  }, [client, agent, sessionId, transcriptPath, hasMore, setList, loadOlderPages])

  // Retain history through any unsettled read so disconnect/error cannot replace the conversation with a card.
  const visibleMessages = transcriptRetentionRef.current.visible({
    identity,
    messages,
    settled: settledReady
  })

  return {
    // Withhold rows until they belong to this identity; passive reset otherwise exposes previous-tab history for one commit.
    messages: visibleMessages,
    status,
    transcriptLoading: status === 'loading' || status === 'awaiting-transcript',
    error,
    hasMore,
    loadingEarlier: olderPages === 'loading',
    olderPages,
    loadEarlier,
    transcriptLifecycle: lifecycle?.identity === identity ? lifecycle.lifecycle : undefined
  }
}
