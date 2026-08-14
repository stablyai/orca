import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import type {
  AgentSessionHistoryResult,
  AgentSessionHandoffStatus,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { AgentJournalCursor } from '../../../src/shared/agent-session-journal-types'
import { createStructuredAgentSessionEventCoalescer } from '../../../src/shared/structured-agent-session-coalescer'
import { projectStructuredItemsToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  shouldAdvanceStructuredResumeCursor,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'
import type { RpcClient } from '../transport/rpc-client'
import {
  createMobileStructuredReconnectState,
  noteStructuredBackground,
  noteStructuredStreamClosed,
  noteStructuredStreamOpened,
  resumeStructuredSession,
  scheduleStructuredStreamLongevityConfirmation
} from './mobile-structured-session-reconnect'

function openStructuredAgentSessionSubscription(args: {
  client: RpcClient
  sessionId: string
  cursor: AgentJournalCursor | null
  onEvent: (raw: unknown) => void
  resumeCursor: () => AgentJournalCursor | null
}): () => void {
  return args.client.subscribe(
    'agentSession.subscribe',
    { sessionId: args.sessionId, ...(args.cursor ? { cursor: args.cursor } : {}) },
    args.onEvent,
    {
      paramsForReconnect: () => ({
        sessionId: args.sessionId,
        ...(args.resumeCursor() ? { cursor: args.resumeCursor() } : {})
      })
    }
  )
}

export function useMobileStructuredAgentSession(args: {
  client: RpcClient | null
  sessionId: string | null
}): {
  messages: ReturnType<typeof projectStructuredItemsToNativeChat>
  items: StructuredAgentSessionState['items']
  submissions: StructuredAgentSessionState['submissions']
  fence: number | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => Promise<boolean>
  handoff: AgentSessionHandoffStatus | null
} {
  const { client, sessionId } = args
  const [state, dispatch] = useReducer(reduceStructuredAgentSession, EMPTY_STRUCTURED_AGENT_SESSION)
  const stateRef = useRef(state)
  stateRef.current = state
  const resumeCursorRef = useRef<AgentJournalCursor | null>(state.cursor)
  resumeCursorRef.current = state.cursor
  const [loadingOlder, setLoadingOlder] = useState(false)
  const reconnectRef = useRef(createMobileStructuredReconnectState())
  const cancelLongevityRef = useRef<() => void>(() => {})

  useEffect(() => {
    dispatch({ type: 'loading' })
    setLoadingOlder(false)
    let closed = false
    let streamOpened = false
    let unsubscribe = (): void => {}
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
      dispatch({ type: 'event', event })
    })
    const cleanup = (): void => {
      closed = true
      cancelLongevityRef.current()
      cancelLongevityRef.current = () => {}
      if (streamOpened) {
        noteStructuredStreamClosed(reconnectRef.current, Date.now())
      }
      coalescer.dispose()
      unsubscribe()
    }
    if (!client || !sessionId) {
      dispatch({ type: 'error', message: '' })
      return cleanup
    }
    const openSubscription = (cursor: AgentJournalCursor | null): void => {
      if (closed) {
        return
      }
      streamOpened = true
      noteStructuredStreamOpened(reconnectRef.current, Date.now())
      cancelLongevityRef.current()
      cancelLongevityRef.current = scheduleStructuredStreamLongevityConfirmation(() => {
        if (!closed) {
          client.confirmStructuredStreamLongevity?.()
        }
      })
      unsubscribe = openStructuredAgentSessionSubscription({
        client,
        sessionId,
        cursor,
        resumeCursor: () => resumeCursorRef.current,
        onEvent: (raw) => {
          if (closed) {
            return
          }
          const event = raw as AgentSessionSubscribeEvent | { type: 'error'; message?: string }
          if (event.type === 'error') {
            coalescer.flush()
            dispatch({
              type: 'error',
              message: event.message ?? 'Conversation stream unavailable'
            })
            return
          }
          if (event.type === 'snapshot' || event.type === 'reset') {
            setLoadingOlder(false)
            resumeCursorRef.current = event.snapshot.cursor
          } else if (event.type === 'batch') {
            const current = resumeCursorRef.current
            if (shouldAdvanceStructuredResumeCursor(current, event.batch.cursor)) {
              resumeCursorRef.current = event.batch.cursor
            }
          }
          coalescer.push(event)
        }
      })
    }
    void Promise.all([
      client.sendRequest('agentSession.history', { sessionId, direction: 'tail', limit: 40 }),
      client.sendRequest('agentSession.handoffStatus', { sessionId }).catch(() => null)
    ])
      .then(([response, handoffResponse]) => {
        if (closed) {
          return
        }
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        if (handoffResponse?.ok) {
          dispatch({
            type: 'handoff',
            handoff: handoffResponse.result as AgentSessionHandoffStatus
          })
        }
        const result = response.result as AgentSessionHistoryResult
        if (result.ok) {
          dispatch({ type: 'tail-page', page: result.page })
          resumeCursorRef.current = result.page.liveCursor ?? null
          openSubscription(result.page.liveCursor ?? null)
          return
        }
        dispatch({
          type: 'event',
          event: {
            type: 'reset',
            sessionId,
            reset: result.reset,
            snapshot: result.snapshot,
            fence: result.fence ?? 0
          }
        })
        resumeCursorRef.current = result.snapshot.cursor
        openSubscription(result.snapshot.cursor)
      })
      .catch((error: unknown) => {
        if (!closed) {
          dispatch({
            type: 'error',
            message: error instanceof Error ? error.message : 'Conversation history unavailable'
          })
        }
      })
    return cleanup
  }, [client, sessionId])

  useEffect(() => {
    if (!client || !sessionId) {
      return
    }
    const onAppState = (next: AppStateStatus): void => {
      if (next === 'active') {
        if (resumeStructuredSession(reconnectRef.current, Date.now()).reconnect) {
          client.restartAfterStructuredBackground?.()
        }
      } else {
        noteStructuredBackground(reconnectRef.current, Date.now())
      }
    }
    const subscription = AppState.addEventListener('change', onAppState)
    return () => subscription.remove()
  }, [client, sessionId])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current
    const cursor = oldestStructuredAgentSessionCursor(current)
    if (!client || !sessionId || !cursor || !current.hasOlder || loadingOlder) {
      return false
    }
    const requestedEpoch = cursor.epoch
    setLoadingOlder(true)
    try {
      const response = await client.sendRequest('agentSession.history', {
        sessionId,
        direction: 'before',
        cursor,
        limit: 40
      })
      if (!response.ok) {
        return false
      }
      const result = response.result as AgentSessionHistoryResult
      if (!result.ok) {
        dispatch({
          type: 'event',
          event: {
            type: 'reset',
            sessionId,
            reset: result.reset,
            snapshot: result.snapshot,
            fence: result.fence ?? 0
          }
        })
        return false
      }
      dispatch({ type: 'older-page', requestedEpoch, page: result.page })
      return stateRef.current.epoch === requestedEpoch && result.page.epoch === requestedEpoch
    } finally {
      setLoadingOlder(false)
    }
  }, [client, loadingOlder, sessionId])

  const messages = useMemo(() => projectStructuredItemsToNativeChat(state.items), [state.items])
  return {
    messages,
    items: state.items,
    submissions: state.submissions,
    fence: state.fence,
    status: !client || !sessionId ? 'idle' : state.status,
    error: state.error || undefined,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
    handoff: state.handoff
  }
}
