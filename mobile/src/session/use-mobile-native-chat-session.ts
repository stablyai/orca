import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { buildNativeChatSubscriptionId } from '../../../src/shared/native-chat-stream-unsubscribe'
import type { RpcClient } from '../transport/rpc-client'
import { createNativeChatMerger, replaceList } from './mobile-native-chat-merge'
import {
  applyMobileNativeChatStreamFrame,
  type MobileNativeChatStreamFrame
} from './mobile-native-chat-stream-frame'

export type MobileNativeChatStatus = 'idle' | 'loading' | 'waiting-session' | 'ready' | 'error'

export type MobileNativeChatSession = {
  messages: NativeChatMessage[]
  status: MobileNativeChatStatus
  error?: string
  /** True when an older page may exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the window to page in older history. */
  loadEarlier: () => void
}

// Small first page for a fast first paint; grows by a page as the user scrolls.
const INITIAL_LIMIT = 40
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
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
}): MobileNativeChatSession {
  const { client, agent, sessionId, transcriptPath } = args
  const [messages, setMessages] = useState<NativeChatMessage[]>([])
  const [status, setStatus] = useState<MobileNativeChatStatus>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
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
    setLoadingEarlier(false)
    setList([])
    setError(undefined)
    setHasMore(false)
    beforeOffsetRef.current = null
    if (!client || !agent) {
      setStatus('idle')
      return
    }
    if (!sessionId) {
      setStatus('waiting-session')
      return
    }

    setStatus('loading')

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
        if (frame.type === 'replacement' || frame.type === 'snapshot') {
          // Why: replacement and reconnect snapshots are authoritative windows;
          // stale page limits/results must not constrain the fresh generation.
          streamGenerationRef.current += 1
          limitRef.current = INITIAL_LIMIT
          loadingEarlierRef.current = false
          setLoadingEarlier(false)
        }
        const replaceSnapshot = frame.type === 'snapshot'
        const applied = applyMobileNativeChatStreamFrame({
          merger: mergerRef.current,
          frame,
          limit: limitRef.current,
          replaceSnapshot
        })
        if (applied.kind === 'ignored') {
          return
        }
        if (applied.kind === 'error') {
          setStatus('error')
          setError(applied.error)
          return
        }
        setMessages(applied.messages)
        if (applied.hasMore != null) {
          setHasMore(applied.hasMore)
        }
        if (applied.beforeOffset != null) {
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
        setStatus('ready')
      }
    )

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, agent, sessionId, transcriptPath, setList])

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
            nextLimit < MAX_MESSAGES && (result.hasMore ?? result.messages.length >= pageLimit)
          )
        } else {
          // Older runtimes ignore the cursor and return the growing tail.
          setList(result.messages)
          setHasMore(result.messages.length >= nextLimit)
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

  return { messages, status, error, hasMore, loadingEarlier, loadEarlier }
}
