import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  NativeChatMessage,
  NativeChatTextRetrieval
} from '../../../src/shared/native-chat-types'
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
  /** True while `messages` cannot be trusted as this session's real history:
   *  the read is in flight, OR the subscription effect has not yet caught up to
   *  a just-changed agent/session, so `messages`/`status` still describe the
   *  previous tab. Consumers that decide something from an empty transcript
   *  (the launch-draft seed) must wait for this to clear. */
  transcriptLoading: boolean
  error?: string
  /** True when an older page may exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the window to page in older history. */
  loadEarlier: () => void
  /** Fetch one full text block represented by a bounded mobile preview. */
  loadFullText: (messageId: string, retrieval: NativeChatTextRetrieval) => Promise<string>
}

// Stable empty reference so a not-yet-current read doesn't churn consumers.
const EMPTY_MESSAGES: NativeChatMessage[] = []

// Small first page for a fast first paint; grows by a page as the user scrolls.
const INITIAL_LIMIT = 40
const PAGE = 60
const MAX_MESSAGES = 2000

type ReadSessionResult =
  | { messages: NativeChatMessage[]; hasMore?: boolean; beforeOffset?: number }
  | { error: string }
type ReadTextBlockResult = { text: string } | { error: string }

function textRetrievalKey(messageId: string, retrieval: NativeChatTextRetrieval): string {
  return `${messageId}\0${retrieval.capability}\0${retrieval.originalChars}`
}

type TextRetrievalIndex = Map<string, Set<string>>

function indexTextRetrievals(messages: readonly NativeChatMessage[]): TextRetrievalIndex {
  const index: TextRetrievalIndex = new Map()
  for (const message of messages) {
    updateTextRetrievalIndex(index, message)
  }
  return index
}

function updateTextRetrievalIndex(index: TextRetrievalIndex, message: NativeChatMessage): void {
  const keys = new Set<string>()
  for (const block of message.blocks) {
    if (block.type === 'text' && block.retrieval) {
      keys.add(textRetrievalKey(message.id, block.retrieval))
    }
  }
  if (keys.size > 0) {
    index.set(message.id, keys)
  } else {
    index.delete(message.id)
  }
}

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
  const identity = `${agent ?? ''}\0${sessionId ?? ''}\0${transcriptPath ?? ''}`
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
  const identityRef = useRef(identity)
  const clientRef = useRef(client)
  const streamGenerationRef = useRef(0)
  const textSourceRevisionRef = useRef(0)
  const [textSourceRevision, setTextSourceRevision] = useState(0)
  const textRetrievalIndexRef = useRef<TextRetrievalIndex>(new Map())

  useLayoutEffect(() => {
    // Async completions must only observe inputs from a committed render.
    sessionIdRef.current = sessionId
    identityRef.current = identity
    clientRef.current = client
  }, [client, identity, sessionId])

  // Replace the base list (read results are an ordered tail). Resets the merger
  // cache so the index is rebuilt once over the new base.
  const setList = useCallback((next: readonly NativeChatMessage[]) => {
    replaceList(mergerRef.current, next)
    textRetrievalIndexRef.current = indexTextRetrievals(mergerRef.current.list)
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
        if (frame.type === 'replacement' || frame.type === 'snapshot') {
          // Why: replacement and reconnect snapshots are authoritative windows;
          // stale page limits/results must not constrain the fresh generation.
          streamGenerationRef.current += 1
          textSourceRevisionRef.current += 1
          setTextSourceRevision(textSourceRevisionRef.current)
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
          setRead({ client, identity, status: 'error' })
          setError(applied.error)
          return
        }
        if (
          frame.type !== 'appended' ||
          applied.cursorInvalidated ||
          !Array.isArray(frame.messages)
        ) {
          textRetrievalIndexRef.current = indexTextRetrievals(applied.messages)
        } else {
          for (const incoming of frame.messages) {
            const index = mergerRef.current.indexById.get(incoming.id)
            const currentMessage = index === undefined ? undefined : applied.messages[index]
            if (currentMessage) {
              updateTextRetrievalIndex(textRetrievalIndexRef.current, currentMessage)
            }
          }
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

  const loadFullText = useCallback(
    async (messageId: string, retrieval: NativeChatTextRetrieval): Promise<string> => {
      if (!client || !agent || !sessionId) {
        throw new Error('Full message unavailable')
      }
      const requestIdentity = identity
      const requestGeneration = streamGenerationRef.current
      const requestTextSourceRevision = textSourceRevision
      const requestRetrievalKey = textRetrievalKey(messageId, retrieval)
      if (!textRetrievalIndexRef.current.get(messageId)?.has(requestRetrievalKey)) {
        throw new Error('Chat transcript changed')
      }
      const response = await client.sendRequest('nativeChat.readTextBlock', {
        capability: retrieval.capability
      })
      if (identityRef.current !== requestIdentity || clientRef.current !== client) {
        throw new Error('Chat session changed')
      }
      if (
        streamGenerationRef.current !== requestGeneration ||
        textSourceRevisionRef.current !== requestTextSourceRevision ||
        !textRetrievalIndexRef.current.get(messageId)?.has(requestRetrievalKey)
      ) {
        throw new Error('Chat transcript changed')
      }
      if (!response.ok) {
        throw new Error('Full message unavailable')
      }
      const result = response.result as ReadTextBlockResult
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.text
    },
    [client, agent, sessionId, identity, textSourceRevision]
  )

  return {
    // Withheld until the settled read belongs to this identity: the effect that
    // clears the previous tab's list is passive, so `messages` lags a commit.
    messages: settled ? messages : EMPTY_MESSAGES,
    status,
    transcriptLoading: status === 'loading',
    error,
    hasMore,
    loadingEarlier,
    loadEarlier,
    loadFullText
  }
}
