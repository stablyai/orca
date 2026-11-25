import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore
} from 'react'
import { isRootAgentJournalItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import {
  type AgentSessionHistoryResult,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../../../../src/shared/agent-session/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../../../src/shared/agent-session/view/structured-agent-session-holder'
import { startStructuredAgentSessionLiveRead } from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-live-read'
import { isFinalAgentSessionReadRefusal } from '../../../../../src/shared/agent-session/failures/structured-agent-session-read-refusal'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../../../src/shared/agent-session/view/live-read/structured-agent-session-reducer'
import { subscribeConnectionRevival } from '../../../diagnostics/connection/connection-revival-signal'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  agentSessionReadFailureRefusal,
  agentSessionReadRefusalText,
  callAgentSession
} from './mobile-structured-agent-session-rpc'
import {
  hostTextAppends,
  subscribeTranscriptAfterHold
} from './mobile-structured-transcript-subscription'
import {
  useMobileOlderPageLoader,
  type OlderPagePhase
} from '../transcript/ingestion/use-mobile-older-page-loader'
import { mobileStructuredAgentSessionWorking } from './mobile-structured-agent-session-working'
import {
  noteChatTranscript,
  storedStructuredSessionState,
  storedStructuredCopy,
  unconfirmedStructuredStateSavedAt
} from '../transcript/persistence/mobile-native-chat-transcript-writer'
import { useStoredChatTranscript } from '../transcript/persistence/use-stored-chat-transcript'
import type { SubmissionReceiptSource } from '../../../../../src/shared/agent-session/view/use-structured-agent-sending'

import { createMobileStructuredChatStateCache } from './mobile-structured-chat-state-cache'

/** The host already batches streamed text, so phones merge only within about a frame; desktop keeps the shared window. */
const STREAMED_TEXT_COALESCE_MS = 16

export function useMobileStructuredAgentState(args: {
  onCommandsChanged?: () => void
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string | null
  enabled: boolean
  // Reacquire holds after transport loss while keeping the transcript visible through the outage.
  connected: boolean
}): {
  state: StructuredAgentSessionState
  stateRef: { readonly current: StructuredAgentSessionState }
  submissionReceipts: SubmissionReceiptSource
  /** Null until the host publishes a queue (older hosts never do). */
  queuedMessages: AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  olderPages: OlderPagePhase
  loadEarlier: () => void
  /** When the transcript on screen was saved, while it is an earlier launch's copy no read has confirmed. */
  savedAt: number | null
} {
  const { client, connected, enabled, sessionId, sessionKey } = args
  const commandsChanged = useRef(args.onCommandsChanged)
  useLayoutEffect(() => {
    commandsChanged.current = args.onCommandsChanged
  }, [args.onCommandsChanged])
  const [cache] = useState(createMobileStructuredChatStateCache)
  const readKey = enabled ? sessionKey : null
  const subscribe = useCallback(
    (listener: () => void) => (readKey ? cache.subscribe(readKey, listener) : () => {}),
    [cache, readKey]
  )
  const retained = useSyncExternalStore(subscribe, () =>
    readKey ? cache.getSnapshot(readKey) : undefined
  )
  const stored =
    enabled && sessionKey && !retained ? storedStructuredSessionState(sessionKey) : null
  const state = retained ?? stored ?? EMPTY_STRUCTURED_AGENT_SESSION
  const { epoch, working, latestTurn, items, submissions, fence } = state
  const publishedRef = useRef(state)
  useLayoutEffect(() => {
    publishedRef.current = state
  }, [state])
  const submissionReceipts = useMemo(
    () => cache.receiptsFor(readKey, epoch, submissions, stored, publishedRef),
    [cache, epoch, readKey, stored, submissions]
  )
  const liveRead = enabled && sessionKey !== null && state.status === 'ready'
  const turnSettled = useMemo(
    () =>
      liveRead &&
      !mobileStructuredAgentSessionWorking({ working, latestTurn, items, submissions, fence }),
    [liveRead, working, latestTurn, items, submissions, fence]
  )
  const readingStore = useStoredChatTranscript({
    identity: enabled && sessionId ? sessionKey : null,
    read: !retained,
    turnSettled
  })
  const { phase: olderPages, load: loadOlderPages, supersede } = useMobileOlderPageLoader()
  const stateRef = useMemo(
    () => ({
      get current() {
        return cache.currentForSnapshot(readKey, publishedRef.current)
      }
    }),
    [cache, readKey]
  )

  const apply = useCallback(
    (action: StructuredAgentSessionAction) => {
      if (!sessionKey) {
        return
      }
      const next = cache.apply(
        sessionKey,
        () => storedStructuredSessionState(sessionKey),
        action,
        Date.now()
      )
      // Remember the receipt and cursor together for the next settle, hide or close flush.
      if (next?.status === 'ready') {
        const isLive = () => client?.getState() === 'connected'
        noteChatTranscript(sessionKey, next, isLive, (at) => storedStructuredCopy(next, at))
      }
    },
    [cache, client, sessionKey]
  )
  useEffect(() => {
    supersede()
    if (!client || !sessionId || !enabled) {
      return
    }
    if (!connected || readingStore) {
      return
    }
    apply({ type: 'loading' })
    const holderId = structuredAgentSessionHolderId('mobile-chat')
    const held = callAgentSession(client, 'agentSession.hold', {
      sessionId,
      holderId
    })
    let ended = false
    const read = startStructuredAgentSessionLiveRead({
      applyRequests: apply,
      applyEvent: (event, options) => {
        apply({ type: 'event', event, ...options })
        if (event.type !== 'end' && event.commandsChanged) {
          commandsChanged.current?.()
        }
      },
      applyError: (message, refusal) => {
        if (stateRef.current.epoch !== null && refusal === undefined) {
          return
        }
        apply(
          refusal
            ? { type: 'error', message: agentSessionReadRefusalText(refusal), refusal }
            : { type: 'error', message }
        )
      },
      getCursor: () =>
        (sessionKey ? cache.get(sessionKey)?.cursor : undefined) ?? stateRef.current.cursor,
      onContactLost: () => {},
      onHistoryReadInvalidated: supersede,
      readCurrentRequests: (request) =>
        callAgentSession(client, 'agentSession.currentRequests', request),
      sessionId,
      subscribe: subscribeTranscriptAfterHold(client, held, () => ended),
      coalesceMs: STREAMED_TEXT_COALESCE_MS,
      textAppend: hostTextAppends(client),
      subscribeRetryNow: subscribeConnectionRevival
    })
    return () => {
      ended = true
      read.dispose()
      void held
        .then(() =>
          callAgentSession(
            client,
            'agentSession.release',
            {
              sessionId,
              holderId
            },
            undefined,
            { failWhenDisconnected: true }
          ).catch(() => undefined)
        )
        .catch(() => undefined)
    }
  }, [
    apply,
    cache,
    client,
    connected,
    enabled,
    readingStore,
    sessionId,
    sessionKey,
    stateRef,
    supersede
  ])

  const loadEarlier = useCallback(() => {
    const start = oldestStructuredAgentSessionCursor(stateRef.current)
    if (!client || !sessionId || !sessionKey || !stateRef.current.hasOlder || !start) {
      return
    }
    let cursor = start
    // Track all heads produced during this tap while refs lag commits; any other head proves live trimming and restarts paging from the new boundary.
    let heads = new Set([start.sequence])
    const intact = (): boolean => {
      const head = oldestStructuredAgentSessionCursor(stateRef.current)
      return head?.epoch === cursor.epoch && heads.has(head.sequence)
    }
    loadOlderPages(async ({ timeoutMs, isCurrent }) => {
      if (!intact()) {
        const head = oldestStructuredAgentSessionCursor(stateRef.current)
        if (!head) {
          return 'end'
        }
        cursor = head
        heads = new Set([head.sequence])
      }
      let result: AgentSessionHistoryResult
      try {
        result = await callAgentSession<AgentSessionHistoryResult>(
          client,
          'agentSession.history',
          { sessionId, direction: 'before', cursor, limit: AGENT_SESSION_HISTORY_MAX_LIMIT },
          timeoutMs
        )
      } catch (error) {
        return isFinalAgentSessionReadRefusal(agentSessionReadFailureRefusal(error))
          ? 'unavailable'
          : 'failed'
      }
      if (!isCurrent()) {
        return 'end'
      }
      if (!result.ok) {
        return 'end'
      }
      if (!intact()) {
        return 'drew-nothing'
      }
      const { page } = result
      apply({ type: 'older-page', requestedCursor: cursor, page })
      const oldest = page.items[0]
      if (!page.hasOlder || !oldest) {
        return 'end'
      }
      heads.add(oldest.sequence)
      cursor = page.window.nextCursor
      // Subagent-only pages add no visible rows; keep paging until the reader has content or history ends.
      return page.items.some(isRootAgentJournalItem) ? 'drew' : 'drew-nothing'
    })
  }, [apply, client, loadOlderPages, sessionId, sessionKey, stateRef])

  // Auto-page once per invisible head: subagent-only windows cannot scroll to request earlier history, including byte-capped first pages.
  const hasOwnItems = useMemo(() => items.some(isRootAgentJournalItem), [items])
  const drawsNothingFrom =
    state.status === 'ready' && state.hasOlder && !hasOwnItems
      ? `${sessionKey}:${state.epoch}:${state.items[0]?.sequence}`
      : null
  const readBackFromRef = useRef<string | null>(null)
  const loadingEarlier = olderPages === 'loading'
  useEffect(() => {
    if (
      drawsNothingFrom === null ||
      loadingEarlier ||
      readBackFromRef.current === drawsNothingFrom
    ) {
      return
    }
    readBackFromRef.current = drawsNothingFrom
    loadEarlier()
  }, [drawsNothingFrom, loadEarlier, loadingEarlier])

  return {
    state,
    stateRef,
    submissionReceipts,
    // A published null is an empty queue; only an absent list is no claim.
    queuedMessages: state.queuedMessages === undefined ? null : (state.queuedMessages ?? []),
    queuePause: state.queuePause ?? null,
    olderPages,
    loadEarlier,
    savedAt: unconfirmedStructuredStateSavedAt(state)
  }
}
