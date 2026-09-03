import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/structured-agent-session-holder'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

const MAX_RETAINED_SESSION_STATES = 32

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
  loadingOlder: boolean
  loadEarlier: () => void
} {
  const { client, connected, enabled, sessionId, sessionKey } = args
  // Keep a bounded cache so offline tab switches select the right transcript
  // synchronously without growing for the lifetime of the app.
  const [sessionStates, setSessionStates] = useState<Map<string, StructuredAgentSessionState>>(
    () => new Map()
  )
  const state =
    enabled && sessionKey
      ? (sessionStates.get(sessionKey) ?? EMPTY_STRUCTURED_AGENT_SESSION)
      : EMPTY_STRUCTURED_AGENT_SESSION
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
        const next = reduceStructuredAgentSession(previous, action)
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

  useEffect(() => {
    streamGenerationRef.current += 1
    sessionKeyRef.current = sessionKey
    setLoadingOlder(false)
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
    let cancelled = false
    let unsubscribe = (): void => {}
    const held = callAgentSession(client, 'agentSession.hold', {
      sessionId,
      holderId
    })
    void held
      .then(() => {
        if (cancelled) {
          return
        }
        unsubscribe = client.subscribe('agentSession.subscribe', { sessionId }, (raw) => {
          if (
            typeof raw === 'object' &&
            raw !== null &&
            (raw as { type?: unknown }).type === 'error'
          ) {
            apply({ type: 'error', message: String((raw as { message?: unknown }).message ?? '') })
            return
          }
          if (isSubscribeEvent(raw)) {
            apply({ type: 'event', event: raw })
          }
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          apply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
    return () => {
      cancelled = true
      unsubscribe()
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
  }, [apply, client, connected, enabled, sessionId, sessionKey])

  const loadEarlier = useCallback(() => {
    const current = stateRef.current
    if (!client || !sessionId || !sessionKey || loadingOlder || !current.hasOlder) {
      return
    }
    const cursor = oldestStructuredAgentSessionCursor(current)
    if (!cursor) {
      return
    }
    const requestSessionKey = sessionKey
    const requestGeneration = streamGenerationRef.current
    setLoadingOlder(true)
    void callAgentSession<AgentSessionHistoryResult>(client, 'agentSession.history', {
      sessionId,
      direction: 'before',
      cursor,
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
      .then((result) => {
        if (
          result.ok &&
          sessionKeyRef.current === requestSessionKey &&
          streamGenerationRef.current === requestGeneration
        ) {
          apply({ type: 'older-page', requestedEpoch: cursor.epoch, page: result.page })
        }
      })
      .catch((error: unknown) => {
        if (
          sessionKeyRef.current === requestSessionKey &&
          streamGenerationRef.current === requestGeneration
        ) {
          apply({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })
      .finally(() => {
        if (
          sessionKeyRef.current === requestSessionKey &&
          streamGenerationRef.current === requestGeneration
        ) {
          setLoadingOlder(false)
        }
      })
  }, [apply, client, loadingOlder, sessionId, sessionKey])

  return { state, stateRef, loadingOlder, loadEarlier }
}
