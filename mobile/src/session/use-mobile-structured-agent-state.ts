import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session-journal-producer'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/structured-agent-session-read-refusal'
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
  callAgentSession
} from './mobile-structured-agent-session-rpc'
import {
  reduceMobileQueuePause,
  reduceMobileQueuedMessageFeed,
  type MobileQueuedMessageFeed,
  type MobileQueuePause
} from './mobile-structured-queued-message-feed'
import { useMobileOlderPageLoader, type OlderPagePhase } from './use-mobile-older-page-loader'

type QueuedFeed = { messages: MobileQueuedMessageFeed; pause: MobileQueuePause }
const NO_QUEUED_FEED: QueuedFeed = { messages: null, pause: null }

const MAX_RETAINED_SESSION_STATES = 32

/**
 * Opens the transcript stream once the hold settles, either way: a refused hold is an older host
 * saying it could not start the agent — which the next send does — never a reason to hide the
 * transcript. Returns what ends the stream, opened or not yet. Outside the effect so its cleanup
 * rule can see the stream is owned.
 */
function openTranscriptAfterHold(
  client: RpcClient,
  sessionId: string,
  held: Promise<unknown>,
  onFrame: (raw: unknown) => void
): () => void {
  let ended = false
  let close = (): void => {}
  void held
    .catch(() => undefined)
    .then(() => {
      if (!ended) {
        close = client.subscribe('agentSession.subscribe', { sessionId }, onFrame)
      }
    })
  return () => {
    ended = true
    close()
  }
}

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
  olderPages: OlderPagePhase
  /** `settled`: the page waits for it before it lands (the phone page, until the reader stops). */
  loadEarlier: (settled?: () => Promise<void>) => void
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
  // The refusal rides beside its words, so the view can tell a failure no retry gets past.
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
    const endStream = openTranscriptAfterHold(client, sessionId, held, (raw) => {
      if (typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'error') {
        applyReadFailure(raw)
        return
      }
      if (isSubscribeEvent(raw)) {
        if (raw.type === 'snapshot' || raw.type === 'reset') {
          // A replaced window ends an older read that was for the old one.
          supersede()
        }
        apply({ type: 'event', event: raw })
        applyQueued(raw)
      }
    })
    return () => {
      supersede()
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
    sessionId,
    sessionKey,
    supersede
  ])

  const loadEarlier = useCallback(
    (settled?: () => Promise<void>) => {
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
        // Lands once the reader stops scrolling, so nothing grows above them mid-fling.
        if (settled) {
          await settled()
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
    },
    [apply, client, loadOlderPages, sessionId, sessionKey]
  )

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
