import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalCursor } from '../../../src/shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session-journal-producer'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import type { AgentProviderSessionMetadata } from '../../../src/shared/agent-session-resume'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureRefusal,
  agentSessionReadFailureText,
  callAgentSession,
  openAgentSessionTranscript
} from './mobile-structured-agent-session-rpc'
import {
  reduceMobileQueuePause,
  reduceMobileQueuedMessageFeed,
  type MobileQueuedMessageFeed,
  type MobileQueuePause
} from './mobile-structured-queued-message-feed'
import {
  NO_MOBILE_PROVIDER_SESSIONS,
  rememberMobileProviderSession,
  type MobileProviderSessions
} from './mobile-structured-provider-session'

type QueuedFeed = { messages: MobileQueuedMessageFeed; pause: MobileQueuePause }
const NO_QUEUED_FEED: QueuedFeed = { messages: null, pause: null }

const MAX_RETAINED_SESSION_STATES = 32
const OLDER_PAGE_ANCHOR_ATTEMPTS = 3
const OLDER_PAGES_PER_LOAD = 8

function isSubscribeEvent(value: unknown): value is AgentSessionSubscribeEvent {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return type === 'snapshot' || type === 'batch' || type === 'reset' || type === 'end'
}

export function useMobileStructuredAgentState(args: {
  client: RpcClient | null
  sessionId: string | null
  sessionKey: string | null
  enabled: boolean
  /** Live transport only. The hold dies with the connection and has to be retaken,
   *  but the transcript must survive the outage rather than blank out with it. */
  connected: boolean
}): {
  state: StructuredAgentSessionState
  stateRef: { readonly current: StructuredAgentSessionState }
  /** Host-held queued drafts from the live stream; null until the host claims any. */
  queuedMessages: MobileQueuedMessageFeed
  /** The whole queue's pause, published with the drafts. */
  queuePause: MobileQueuePause
  /** Provider sessions a history read named, by chat id; what a terminal resume needs. */
  providerSessions: MobileProviderSessions
  loadingOlder: boolean
  loadEarlier: () => void
} {
  const { client, connected, enabled, sessionId, sessionKey } = args
  const [sessionStates, setSessionStates] = useState<Map<string, StructuredAgentSessionState>>(
    () => new Map()
  )
  const [queuedBySession, setQueuedBySession] = useState<Map<string, QueuedFeed>>(() => new Map())
  const [providerSessions, setProviderSessions] = useState<MobileProviderSessions>(
    () => NO_MOBILE_PROVIDER_SESSIONS
  )
  const state =
    enabled && sessionKey
      ? (sessionStates.get(sessionKey) ?? EMPTY_STRUCTURED_AGENT_SESSION)
      : EMPTY_STRUCTURED_AGENT_SESSION
  const queued =
    (enabled && sessionKey ? queuedBySession.get(sessionKey) : undefined) ?? NO_QUEUED_FEED
  const [loadingOlder, setLoadingOlder] = useState(false)
  const stateRef = useRef(state)
  const sessionKeyRef = useRef(sessionKey)
  const streamGenerationRef = useRef(0)
  useLayoutEffect(() => {
    stateRef.current = state
    sessionKeyRef.current = sessionKey
  }, [sessionKey, state])

  const apply = useCallback(
    (action: StructuredAgentSessionAction) => {
      if (!sessionKey) {
        return
      }
      setSessionStates((current) => {
        const previous = current.get(sessionKey) ?? EMPTY_STRUCTURED_AGENT_SESSION
        const next = reduceStructuredAgentSession(previous, action, Date.now())
        if (next === previous) {
          return current
        }
        const updated = new Map(current)
        updated.delete(sessionKey)
        updated.set(sessionKey, next)
        while (updated.size > MAX_RETAINED_SESSION_STATES) {
          const oldest = updated.keys().next().value
          if (oldest === undefined) {
            break
          }
          updated.delete(oldest)
        }
        return updated
      })
    },
    [sessionKey]
  )
  const applyReadFailure = useCallback(
    (failure: unknown) => {
      const refusal = agentSessionReadFailureRefusal(failure)
      apply({
        type: 'error',
        message: agentSessionReadFailureText(failure),
        ...(refusal ? { refusal } : {})
      })
    },
    [apply]
  )

  const applyQueued = useCallback(
    (event: AgentSessionSubscribeEvent) => {
      if (!sessionKey) {
        return
      }
      setQueuedBySession((current) => {
        const previous = current.get(sessionKey) ?? NO_QUEUED_FEED
        const messages = reduceMobileQueuedMessageFeed(previous.messages, event)
        const pause = reduceMobileQueuePause(previous.pause, event)
        if (messages === previous.messages && pause === previous.pause) {
          return current
        }
        const updated = new Map(current)
        updated.delete(sessionKey)
        updated.set(sessionKey, { messages, pause })
        while (updated.size > MAX_RETAINED_SESSION_STATES) {
          const oldest = updated.keys().next().value
          if (oldest === undefined) {
            break
          }
          updated.delete(oldest)
        }
        return updated
      })
    },
    [sessionKey]
  )

  const keepProviderSession = useCallback(
    (sid: string, reported: AgentProviderSessionMetadata | undefined) => {
      setProviderSessions((current) => rememberMobileProviderSession(current, sid, reported))
    },
    []
  )

  useEffect(() => {
    streamGenerationRef.current += 1
    sessionKeyRef.current = sessionKey
    setLoadingOlder(false)
    if (!client || !sessionId || !enabled) {
      return
    }
    if (!connected) {
      return
    }
    apply({ type: 'loading' })
    const holderId = structuredAgentSessionHolderId('mobile-chat')
    const held = callAgentSession(client, 'agentSession.hold', {
      sessionId,
      holderId
    })
    const endStream = openAgentSessionTranscript(client, sessionId, held, (raw) => {
      if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'error') {
        applyReadFailure(raw)
        return
      }
      if (isSubscribeEvent(raw)) {
        keepProviderSession(sessionId, raw.type === 'snapshot' ? raw.providerSession : undefined)
        apply({ type: 'event', event: raw })
        applyQueued(raw)
      }
    })
    return () => {
      endStream()
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
    applyQueued,
    applyReadFailure,
    client,
    connected,
    enabled,
    keepProviderSession,
    sessionId,
    sessionKey
  ])

  const loadEarlier = useCallback(() => {
    if (!client || !sessionId || !sessionKey || loadingOlder || !stateRef.current.hasOlder) {
      return
    }
    if (!oldestStructuredAgentSessionCursor(stateRef.current)) {
      return
    }
    const requestGeneration = streamGenerationRef.current
    const isCurrentRead = (): boolean =>
      sessionKeyRef.current === sessionKey && streamGenerationRef.current === requestGeneration
    setLoadingOlder(true)
    void (async () => {
      // A live batch can head-trim past the anchor mid-read, and the reducer drops that
      // page rather than leave a hole in the transcript. Re-anchor and retry.
      for (let attempt = 0; attempt < OLDER_PAGE_ANCHOR_ATTEMPTS; attempt += 1) {
        const cursor = oldestStructuredAgentSessionCursor(stateRef.current)
        if (!cursor || !isCurrentRead()) {
          return
        }
        // Mobile draws only the session's own rows, so a page of a subagent's rows alone
        // would land as nothing; read on until a page adds a row the reader can see. Older
        // hosts send one for any burst; current ones when the page's byte bound cuts it short.
        const pages: { requestedCursor: AgentJournalCursor; page: AgentSessionHistoryPage }[] = []
        let requestedCursor = cursor
        while (pages.length < OLDER_PAGES_PER_LOAD) {
          const result = await callAgentSession<AgentSessionHistoryResult>(
            client,
            'agentSession.history',
            {
              sessionId,
              direction: 'before',
              cursor: requestedCursor,
              limit: AGENT_SESSION_HISTORY_MAX_LIMIT
            }
          )
          keepProviderSession(sessionId, result.providerSession)
          if (!result.ok || !isCurrentRead()) {
            break
          }
          pages.push({ requestedCursor, page: result.page })
          if (
            !result.page.hasOlder ||
            result.page.items.length === 0 ||
            result.page.items.some(isRootAgentJournalItem)
          ) {
            break
          }
          requestedCursor = result.page.window.nextCursor
        }
        if (pages.length === 0 || !isCurrentRead()) {
          return
        }
        if (oldestStructuredAgentSessionCursor(stateRef.current)?.sequence === cursor.sequence) {
          for (const { requestedCursor: pageCursor, page } of pages) {
            apply({ type: 'older-page', requestedCursor: pageCursor, page })
          }
          return
        }
      }
    })()
      .catch((error: unknown) => {
        if (isCurrentRead()) {
          applyReadFailure(error)
        }
      })
      .finally(() => {
        if (isCurrentRead()) {
          setLoadingOlder(false)
        }
      })
  }, [apply, applyReadFailure, client, keepProviderSession, loadingOlder, sessionId, sessionKey])

  const drawsNothingFrom =
    state.status === 'ready' && state.hasOlder && !state.items.some(isRootAgentJournalItem)
      ? `${sessionKey}:${state.epoch}:${state.items[0]?.sequence}`
      : null
  const readBackFromRef = useRef<string | null>(null)
  useEffect(() => {
    if (drawsNothingFrom === null || loadingOlder || readBackFromRef.current === drawsNothingFrom) {
      return
    }
    readBackFromRef.current = drawsNothingFrom
    loadEarlier()
  }, [drawsNothingFrom, loadEarlier, loadingOlder])

  return {
    state,
    stateRef,
    queuedMessages: queued.messages,
    queuePause: queued.pause,
    providerSessions,
    loadingOlder,
    loadEarlier
  }
}
