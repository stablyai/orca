import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from '../../../src/shared/native-chat-transcript-retention'
import { createNativeChatMerger, replaceList } from '../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat-stream-unsubscribe'
import type { RpcClient } from '../transport/rpc-client'
import {
  applyMobileNativeChatStreamFrame,
  type MobileNativeChatStreamFrame
} from './mobile-native-chat-stream-frame'

export type MobileNativeChatStatus = 'idle' | 'loading' | 'waiting-session' | 'ready' | 'error'

export type MobileNativeChatSession = {
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  /** True while `messages` cannot be trusted as this session's real history:
   *  the read is in flight, OR the subscription effect has not yet caught up to
   *  a just-changed agent/session, so `messages`/`status` still describe the
   *  previous tab. Consumers that decide something from an empty transcript
   *  (the launch-draft seed) must wait for this to clear. */
  transcriptLoading: boolean
  error?: string
  /** True when an older page may exist (the last read filled the window). */
  hasMore: boolean
  /** True when older history is KNOWN to exist, rather than guessed from a full
   *  window. `hasMore` falls back to a count inference that reports true for a
   *  window filled to exactly the limit; that is fine for the "load earlier"
   *  affordance but not for the marker fold, which changes what a message says —
   *  a false positive there erases an `[Image #n]` the user typed, and the limit
   *  here is 40, so an exact fill is far likelier than on desktop.
   *
   *  Usually that knowledge is the host's own answer. It is not always: a replay
   *  that invalidates the cursor synthesizes it, because a bounded window that
   *  dropped its oldest row really does have history behind it. Both are facts
   *  about the transcript; neither is a count standing in for one. */
  earlierHistoryConfirmed: boolean
  /** The oldest row of the window the host answered about, while it is still on
   *  screen. Only that row may have lost the `[Image: source: …]` turns that
   *  vouch for its markers; undefined means no row may lose any. */
  windowHeadMessageId: string | undefined
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the window to page in older history. */
  loadEarlier: () => void
}

// Small first page for a fast first paint; grows by a page as the user scrolls.
const INITIAL_LIMIT = 40

/** The host's paging answer, or undefined when it did not give one. Both mobile
 *  hops cast the wire payload without validating per-field types, so a
 *  non-boolean must read as "unanswered" rather than force a paging verdict —
 *  the same guard the desktop runtime parser enforces. */
export function reportedHasMore(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
const PAGE = 60
const MAX_MESSAGES = 2000

type ReadSessionResult =
  | { messages: NativeChatMessage[]; hasMore?: boolean; beforeOffset?: number }
  | { error: string }
/** Subscribe to an agent's native-chat transcript over the paired connection.
 *  Reads a small recent window for a fast first paint, tails it for live turns,
 *  and pages in older history on demand. Read results replace the list (they are
 *  an ordered tail); live appends merge by id so order stays stable. */
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
  // Pre-read status is a pure function of the props, so derive it rather than
  // letting the effect write it a commit later.
  const initialStatus: MobileNativeChatStatus =
    !client || !agent ? 'idle' : !sessionId ? 'waiting-session' : 'loading'
  // Only the settled outcome is genuinely async, and it is tagged with the
  // identity it describes so a just-switched tab is never judged by the
  // previous tab's transcript — the effect that clears `messages` is passive
  // and lands a commit late.
  const [read, setRead] = useState<{
    client: RpcClient
    identity: string
    status: MobileNativeChatStatus
  } | null>(null)
  // Drop it the moment its subscription stops being the live one — identity and
  // client are the effect's only inputs, so together they catch every re-run.
  // Without this a toggle out of chat view and back (agent null, then the same
  // identity again) would resurface a settled 'ready' over an emptied list.
  let current = read
  if (current !== null && (current.identity !== identity || current.client !== client)) {
    current = null
    setRead(null)
  }
  // A settled read only counts while the props still call for one: losing the
  // client/agent/session means idle or waiting-session outranks it outright.
  const settled = initialStatus === 'loading' ? current : null
  const status = settled ? settled.status : initialStatus
  const [error, setError] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [earlierHistoryConfirmed, setEarlierHistoryConfirmed] = useState(false)
  // The oldest row of the window the host answered about. Recorded from reads
  // only: a live append trims the front locally, and the row that slides up was
  // already on screen rendered literally, so re-reading it as a window head
  // would rewrite a message the user had already seen.
  const [windowHeadMessageId, setWindowHeadMessageId] = useState<string | undefined>(undefined)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const loadingEarlierRef = useRef(false)
  const beforeOffsetRef = useRef<number | null>(null)
  // Stateful id-dedup merger: caches the id→index map so each live append frame
  // costs O(incoming), not O(existing+incoming) (#18). `replaceList` resets the
  // base (read / loadEarlier ordered tails); `applyAppend` folds live frames in.
  const mergerRef = useRef(createNativeChatMerger())
  const limitRef = useRef(INITIAL_LIMIT)
  // Tracks the live session so a late loadEarlier resolve can detect a swap.
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId
  const streamGenerationRef = useRef(0)
  // Whether this subscription already delivered its base snapshot; later
  // snapshots on the same subscription are reconnect replays, not fresh bases.
  const snapshotSeenRef = useRef(false)
  const transcriptRetentionRef = useRef(createNativeChatTranscriptRetention())
  const settledReady = settled?.status === 'ready'
  useEffect(() => {
    if (settledReady) {
      transcriptRetentionRef.current.capture(identity, messages)
    }
  }, [identity, messages, settledReady])

  // Replace the base list (read results are an ordered tail). Resets the merger
  // cache so the index is rebuilt once over the new base.
  const setList = useCallback((next: readonly NativeChatMessage[]) => {
    replaceList(mergerRef.current, next)
    setMessages(mergerRef.current.list)
  }, [])

  useEffect(() => {
    let cancelled = false
    // Why: disconnect/agent/session loss must invalidate a page request before
    // the early idle/waiting return can clear the visible source.
    streamGenerationRef.current += 1
    limitRef.current = INITIAL_LIMIT
    loadingEarlierRef.current = false
    snapshotSeenRef.current = false
    setLoadingEarlier(false)
    setList([])
    setError(undefined)
    setHasMore(false)
    setEarlierHistoryConfirmed(false)
    setWindowHeadMessageId(undefined)
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
        subscriptionId: buildNativeChatSubscriptionId(agent, sessionId),
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
          limit: limitRef.current,
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
        if (frame.type === 'snapshot') {
          snapshotSeenRef.current = true
        }
        if (applied.windowReplaced || frame.type === 'snapshot') {
          // Why: any authoritative window (and any replay merge) invalidates an
          // in-flight older-page request; stale results must not land on it.
          streamGenerationRef.current += 1
          loadingEarlierRef.current = false
          setLoadingEarlier(false)
        }
        if (applied.windowReplaced) {
          // Only a genuinely fresh window resets the grown read window — an
          // overlapping reconnect replay keeps the paged-in history and limit.
          limitRef.current = INITIAL_LIMIT
          beforeOffsetRef.current = applied.beforeOffset ?? null
          setHasMore(reportedHasMore(applied.hasMore) ?? applied.messages.length >= INITIAL_LIMIT)
          setEarlierHistoryConfirmed(reportedHasMore(applied.hasMore) === true)
          setWindowHeadMessageId(applied.messages[0]?.id)
        }
        setMessages(applied.messages)
        const appliedHasMore = reportedHasMore(applied.hasMore)
        if (!applied.windowReplaced && appliedHasMore !== undefined) {
          setHasMore(appliedHasMore)
          setEarlierHistoryConfirmed(appliedHasMore)
        }
        if (!applied.windowReplaced && applied.beforeOffset != null) {
          beforeOffsetRef.current = applied.beforeOffset
        }
        if (applied.cursorInvalidated) {
          // Fall back to a growing-tail read so history trimmed by live appends
          // cannot leave a gap between the retained window and the old cursor.
          streamGenerationRef.current += 1
          loadingEarlierRef.current = false
          setLoadingEarlier(false)
          beforeOffsetRef.current = null
        }
        setRead({ client, identity, status: 'ready' })
      }
    )

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, agent, sessionId, transcriptPath, identity, setList])

  const loadEarlier = useCallback(() => {
    if (!client || !agent || !sessionId || loadingEarlierRef.current || !hasMore) {
      return
    }
    // Capture the session this page belongs to; a swap underneath us must not
    // apply this read's result onto the new session (mirrors desktop's guard).
    const requestSessionId = sessionId
    const requestGeneration = streamGenerationRef.current
    const nextLimit = Math.min(limitRef.current + PAGE, MAX_MESSAGES)
    const pageLimit = nextLimit - limitRef.current
    if (pageLimit <= 0) {
      setHasMore(false)
      setEarlierHistoryConfirmed(false)
      setWindowHeadMessageId(undefined)
      return
    }
    const beforeOffset = beforeOffsetRef.current
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    void (async () => {
      try {
        const response = await client.sendRequest('nativeChat.readSession', {
          agent,
          sessionId,
          limit: beforeOffset === null ? nextLimit : pageLimit,
          ...(beforeOffset === null ? {} : { beforeOffset }),
          ...(transcriptPath ? { transcriptPath } : {})
        })
        if (!response.ok) {
          return
        }
        const result = response.result as ReadSessionResult
        if ('error' in result) {
          return
        }
        // Drop a stale resolve from a session that swapped underneath us.
        if (
          sessionIdRef.current !== requestSessionId ||
          streamGenerationRef.current !== requestGeneration
        ) {
          return
        }
        limitRef.current = nextLimit
        if (beforeOffset !== null && result.beforeOffset != null) {
          beforeOffsetRef.current = result.beforeOffset
          setList([...result.messages, ...mergerRef.current.list])
          setHasMore(
            nextLimit < MAX_MESSAGES &&
              (reportedHasMore(result.hasMore) ?? result.messages.length >= pageLimit)
          )
          setEarlierHistoryConfirmed(reportedHasMore(result.hasMore) === true)
          setWindowHeadMessageId(result.messages[0]?.id)
        } else {
          // Older runtimes ignore the cursor and return the growing tail.
          setList(result.messages)
          setHasMore(result.messages.length >= nextLimit)
          setEarlierHistoryConfirmed(false)
          setWindowHeadMessageId(undefined)
        }
      } finally {
        // A late page from a prior tab must not unlock the current tab's request.
        if (
          sessionIdRef.current === requestSessionId &&
          streamGenerationRef.current === requestGeneration
        ) {
          loadingEarlierRef.current = false
          setLoadingEarlier(false)
        }
      }
    })()
  }, [client, agent, sessionId, transcriptPath, hasMore, setList])

  // Held for any unsettled read, not just an in-flight one: a stream error or a
  // dropped client would otherwise trade the conversation for an error card.
  const visibleMessages = transcriptRetentionRef.current.visible({
    identity,
    messages,
    settled: settledReady
  })

  return {
    // Withheld until the settled read belongs to this identity: the effect that
    // clears the previous tab's list is passive, so `messages` lags a commit.
    messages: visibleMessages,
    status,
    transcriptLoading: status === 'loading',
    error,
    hasMore,
    earlierHistoryConfirmed,
    // Undefined once a live trim drops the recorded head: nothing on screen is
    // then known to sit mid-image-run, so no row may lose its markers.
    windowHeadMessageId:
      earlierHistoryConfirmed && visibleMessages.some((m) => m.id === windowHeadMessageId)
        ? windowHeadMessageId
        : undefined,
    loadingEarlier,
    loadEarlier
  }
}
