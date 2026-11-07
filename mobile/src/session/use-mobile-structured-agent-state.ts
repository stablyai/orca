import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import {
  type AgentSessionHistoryResult,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../../src/shared/agent-session/agent-session-wire'
import { structuredAgentSessionHolderId } from '../../../src/shared/agent-session/view/structured-agent-session-holder'
import { startStructuredAgentSessionLiveRead } from '../../../src/shared/agent-session/structured-agent-session-live-read'
import { isFinalAgentSessionReadRefusal } from '../../../src/shared/agent-session/failures/structured-agent-session-read-refusal'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  oldestStructuredAgentSessionCursor,
  reduceStructuredAgentSession,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from '../../../src/shared/agent-session/structured-agent-session-reducer'
import { subscribeConnectionRevival } from '../transport/connection-revival-signal'
import { readRuntimeStatusProbe, recordRuntimeStatusProbe } from '../transport/runtime-status-probe'
import { hostStatusProbe, readProbedHostStatus } from '../transport/host-status-probe-operations'
import { hostStatusSchema } from '../transport/host-status-reply-schema'
import { AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import {
  agentSessionReadFailureRefusal,
  agentSessionReadRefusalText,
  callAgentSession
} from './mobile-structured-agent-session-rpc'
import { subscribeTranscriptAfterHold } from './mobile-structured-transcript-subscription'
import { useMobileOlderPageLoader, type OlderPagePhase } from './use-mobile-older-page-loader'

const MAX_RETAINED_SESSION_STATES = 32
/** The host already batches streamed text, so phones merge only within about a frame; desktop keeps the shared window. */
const STREAMED_TEXT_COALESCE_MS = 16

// Read alongside the hold, so the stream's first open knows whether to ask for appends: this
// connection's probe, else the status the shell proved (direct hosts only), else one read.
async function hostStreamsTextAppends(client: RpcClient): Promise<boolean> {
  let status = readRuntimeStatusProbe(client)
  const shell =
    status === undefined ? hostStatusSchema.safeParse(client.getShellHostStatus?.()) : null
  if (shell?.success) {
    status = shell.data
  } else if (status === undefined) {
    const reply = await hostStatusProbe
      .request(client, undefined, { timeoutMs: 15_000, failWhenDisconnected: true })
      .catch(() => null)
    const landed = reply ? readProbedHostStatus(reply) : null
    if (landed) {
      recordRuntimeStatusProbe(client, landed.status)
    }
    status = landed?.status
  }
  return status?.capabilities?.includes(AGENT_SESSION_TEXT_APPEND_RUNTIME_CAPABILITY) === true
}

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
  /** Null until the host publishes a queue (older hosts never do). */
  queuedMessages: AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  olderPages: OlderPagePhase
  loadEarlier: () => void
} {
  const { client, connected, enabled, sessionId, sessionKey } = args
  const commandsChanged = useRef(args.onCommandsChanged)
  useLayoutEffect(() => {
    commandsChanged.current = args.onCommandsChanged
  }, [args.onCommandsChanged])
  // Bound synchronous per-session retention so offline tab switches cannot grow memory indefinitely.
  const [sessionStates, setSessionStates] = useState<Map<string, StructuredAgentSessionState>>(
    () => new Map()
  )
  const state =
    enabled && sessionKey
      ? (sessionStates.get(sessionKey) ?? EMPTY_STRUCTURED_AGENT_SESSION)
      : EMPTY_STRUCTURED_AGENT_SESSION
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
  useEffect(() => {
    supersede()
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
      getCursor: () => stateRef.current.cursor,
      onContactLost: () => {},
      onHistoryReadInvalidated: supersede,
      readCurrentRequests: (request) =>
        callAgentSession(client, 'agentSession.currentRequests', request),
      sessionId,
      subscribe: subscribeTranscriptAfterHold(client, held, () => ended),
      coalesceMs: STREAMED_TEXT_COALESCE_MS,
      textAppend: hostStreamsTextAppends(client),
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
  }, [apply, client, connected, enabled, sessionId, sessionKey, supersede])

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
  }, [apply, client, loadOlderPages, sessionId, sessionKey])

  // Auto-page once per invisible head: subagent-only windows cannot scroll to request earlier history, including byte-capped first pages.
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

  return {
    state,
    stateRef,
    // A published null is an empty queue; only an absent list is no claim.
    queuedMessages: state.queuedMessages === undefined ? null : (state.queuedMessages ?? []),
    queuePause: state.queuePause ?? null,
    olderPages,
    loadEarlier
  }
}
