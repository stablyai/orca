import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { applyAppend, createNativeChatMerger, replaceList } from './mobile-native-chat-merge'

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

type ReadSessionResult = { messages: NativeChatMessage[] } | { error: string }
type AppendedFrame = { type?: string; messages?: NativeChatMessage[] }

/** Subscribe to an agent's native-chat transcript over the paired connection.
 *  Reads a small recent window for a fast first paint, tails it for live turns,
 *  and pages in older history on demand. Read results replace the list (they are
 *  an ordered tail); live appends merge by id so order stays stable. */
export function useMobileNativeChatSession(args: {
  client: RpcClient | null
  agent: string | null
  sessionId: string | null
  /** Authoritative transcript path from the hook, preferred over the id glob. */
  transcriptPath?: string | null
}): MobileNativeChatSession {
  const { client, agent, sessionId, transcriptPath } = args
  const [messages, setMessages] = useState<NativeChatMessage[]>([])
  const [status, setStatus] = useState<MobileNativeChatStatus>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Stateful id-dedup merger: caches the id→index map so each live append frame
  // costs O(incoming), not O(existing+incoming) (#18). `replaceList` resets the
  // base (read / loadEarlier ordered tails); `applyAppend` folds live frames in.
  const mergerRef = useRef(createNativeChatMerger())
  const limitRef = useRef(INITIAL_LIMIT)
  // Tracks the live session so a late loadEarlier resolve can detect a swap.
  const sessionIdRef = useRef<string | null>(sessionId)
  sessionIdRef.current = sessionId

  // Replace the base list (read results are an ordered tail). Resets the merger
  // cache so the index is rebuilt once over the new base.
  const setList = useCallback((next: readonly NativeChatMessage[]) => {
    replaceList(mergerRef.current, next)
    setMessages(mergerRef.current.list)
  }, [])

  useEffect(() => {
    if (!client || !agent) {
      setList([])
      setStatus('idle')
      return
    }
    if (!sessionId) {
      setList([])
      setStatus('waiting-session')
      return
    }

    let cancelled = false
    limitRef.current = INITIAL_LIMIT
    setList([])
    setStatus('loading')
    setError(undefined)
    setHasMore(false)

    void (async () => {
      try {
        const response = await client.sendRequest('nativeChat.readSession', {
          agent,
          sessionId,
          limit: limitRef.current,
          transcriptPath: transcriptPath ?? undefined
        })
        if (cancelled) {
          return
        }
        if (!response.ok) {
          setStatus('error')
          setError(response.error.message)
          return
        }
        const result = response.result as ReadSessionResult
        if ('error' in result) {
          setStatus('error')
          setError(result.error)
          return
        }
        // Read results are an ordered tail — replace, don't merge, so paging
        // older history keeps chronological order.
        setList(result.messages)
        setStatus('ready')
        setHasMore(result.messages.length >= limitRef.current)
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setError(e instanceof Error ? e.message : 'Failed to load conversation')
        }
      }
    })()

    const unsubscribe = client.subscribe(
      'nativeChat.subscribe',
      { agent, sessionId, transcriptPath: transcriptPath ?? undefined },
      (raw) => {
        const frame = raw as AppendedFrame
        if (cancelled || frame.type !== 'appended' || !Array.isArray(frame.messages)) {
          return
        }
        // Live turns merge by id (appended at the end) onto the current window;
        // the cached index keeps this O(incoming).
        setMessages(applyAppend(mergerRef.current, frame.messages))
        setStatus('ready')
      }
    )

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, agent, sessionId, transcriptPath, setList])

  const loadEarlier = useCallback(() => {
    if (!client || !agent || !sessionId || loadingEarlier || !hasMore) {
      return
    }
    // Capture the session this page belongs to; a swap underneath us must not
    // apply this read's result onto the new session (mirrors desktop's guard).
    const requestSessionId = sessionId
    const nextLimit = limitRef.current + PAGE
    setLoadingEarlier(true)
    void (async () => {
      try {
        const response = await client.sendRequest('nativeChat.readSession', {
          agent,
          sessionId,
          limit: nextLimit,
          transcriptPath: transcriptPath ?? undefined
        })
        if (!response.ok) {
          return
        }
        const result = response.result as ReadSessionResult
        if ('error' in result) {
          return
        }
        // Drop a stale resolve from a session that swapped underneath us.
        if (sessionIdRef.current !== requestSessionId) {
          return
        }
        limitRef.current = nextLimit
        setList(result.messages)
        setHasMore(result.messages.length >= nextLimit)
      } finally {
        setLoadingEarlier(false)
      }
    })()
  }, [client, agent, sessionId, transcriptPath, hasMore, loadingEarlier, setList])

  return { messages, status, error, hasMore, loadingEarlier, loadEarlier }
}
