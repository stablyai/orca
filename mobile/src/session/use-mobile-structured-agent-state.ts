import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session-journal-producer'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import { startStructuredAgentSessionLiveRead } from '../../../src/shared/structured-agent-session-live-read'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import { subscribeConnectionRevival } from '../transport/connection-revival-signal'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureRefusal,
  agentSessionReadRefusalText,
  callAgentSession
} from './mobile-structured-agent-session-rpc'
import { subscribeTranscriptAfterHold } from './mobile-structured-transcript-subscription'
import {
  reduceMobileQueuePause,
  reduceMobileQueuedMessageFeed,
  type MobileQueuedMessageFeed,
  type MobileQueuePause
} from './mobile-structured-queued-message-feed'
import { useMobileOlderPageLoader, type OlderPagePhase } from './use-mobile-older-page-loader'

type QueuedFeed = {
  messages: MobileQueuedMessageFeed
  pause: MobileQueuePause
}
const NO_QUEUED_FEED: QueuedFeed = { messages: null, pause: null }

const MAX_RETAINED_SESSION_STATES = 32

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
  olderPages: OlderPagePhase
  loadEarlier: () => void
} {
  const { client, connected, enabled, sessionId, sessionKey } = args
  // Keep a bounded cache so offline tab switches select the right transcript
  // synchronously without growing for the lifetime of the app.
  const [sessionStates, setSessionStates] = useState<Map<string, StructuredAgentSessionState>>(
    () => new Map()
  )
  const [queuedBySession, setQueuedBySession] = useState<Map<string, QueuedFeed>>(() => new Map())
  const state =
    enabled && sessionKey
      ? (sessionStates.get(sessionKey) ?? EMPTY_STRUCTURED_AGENT_SESSION)
      : EMPTY_STRUCTURED_AGENT_SESSION
  const queued =
    (enabled && sessionKey ? queuedBySession.get(sessionKey) : undefined) ?? NO_QUEUED_FEED
  const queuedMessages = queued.messages
  const { phase: olderPages, load: loadOlderPages, supersede } = useMobileOlderPageLoader()
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

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

  useEffect(() => {
    supersede()
    if (!client || !sessionId || !enabled) {
      return
    }
    if (!connected) {
      // The cleanup above drops the dead hold and stream; keyed state keeps this
      // session's transcript visible while another tab can be selected.
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
        applyQueued(event)
      },
      applyError: (message, refusal) => {
        // As on desktop: a loaded transcript stays as it is while the read reopens; a refusal is shown.
        if (stateRef.current.epoch !== null && refusal === undefined) {
          return
        }
        apply(
          refusal
            ? { type: 'error', message: agentSessionReadRefusalText(refusal), refusal }
            : { type: 'error', message }
        )
      },
      getCursor: () => stateRef.current.cursor,
      onContactLost: () => {},
      // A replaced window, reopen or teardown ends an older read that was for the old one.
      onHistoryReadInvalidated: supersede,
      readCurrentRequests: (request) =>
        callAgentSession(client, 'agentSession.currentRequests', request),
      sessionId,
      subscribe: subscribeTranscriptAfterHold(client, held, () => ended),
      // The app coming back (or a new network) cuts a grown reopen wait short.
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
  }, [apply, applyQueued, client, connected, enabled, sessionId, sessionKey, supersede])

  const loadEarlier = useCallback(() => {
    const start = oldestStructuredAgentSessionCursor(stateRef.current)
    if (!client || !sessionId || !sessionKey || !stateRef.current.hasOlder || !start) {
      return
    }
    let cursor = start
    // Every head this tap produced. Any other head means a live batch trimmed the window mid-tap,
    // and the reducer drops a page that no longer abuts it, so the read restarts from that head.
    // Holding them all keeps the check right while `stateRef` lags a commit behind a landed page.
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
        // Every reset reason makes the subscription reload a fresh window, which replaces this one.
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
      // Mobile draws only the session's own rows, so a page of a subagent's rows alone lands as
      // nothing; the loader reads on until a page adds a row the reader can see.
      return page.items.some(isRootAgentJournalItem) ? 'drew' : 'drew-nothing'
    })
  }, [apply, client, loadOlderPages, sessionId, sessionKey])

  // A window of only a subagent's rows draws nothing, and an empty list cannot be scrolled
  // to ask for more, so it reads back once from each such head. A first page can be one: an
  // older host's for any burst, a current host's when a burst fills its byte bound.
  const drawsNothingFrom =
    state.status === 'ready' && state.hasOlder && !state.items.some(isRootAgentJournalItem)
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

  return { state, stateRef, queuedMessages, queuePause: queued.pause, olderPages, loadEarlier }
}
