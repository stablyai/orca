import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult,
  type AgentSessionRegisteredAgent
} from '../../../../src/shared/agent-session/agent-session-registered-agents'
import type { AgentSessionOptionsResult } from '../../../../src/shared/agent-session/options/agent-session-options-result'
import { AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session/agent-session-create-capabilities'
import { latestAgentSessionContextClearSequence } from '../../../../src/shared/agent-session/agent-session-context-clear'
import {
  isAgentSessionHandleProvider,
  type AgentSessionHandleProvider
} from '../../../../src/shared/agent-session/lifecycle/agent-session-provider-handle'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/structured-agent-session-create'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../src/shared/agent-session/structured-agent-session-host-capability'
import {
  nativeChatForkableItemIds,
  nativeChatForkSupport,
  nativeChatRowOffersFork
} from '../../../../src/shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { isRootAgentJournalItem } from '../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import type { RpcClient } from '../../transport/rpc-client'

/** The fork a response offers: none, an empty held slot, drawn disabled, or pressable. */
export type MobileNativeChatForkOffer = 'hidden' | 'reserved' | 'disabled' | 'available'

export type MobileNativeChatFork = {
  subscribe: (listener: () => void) => () => void
  offerFor: (message: NativeChatMessage) => MobileNativeChatForkOffer
  fork: (message: NativeChatMessage) => void
}

export const MobileNativeChatForkContext = createContext<MobileNativeChatFork | null>(null)

const AGENTS_READ_RETRIES_MS = [2_000, 8_000, 30_000]

/** The host's agents, read once per connection, only from a host that can fork. */
function useRegisteredAgent(
  client: RpcClient | null,
  host: StructuredAgentSessionHostCapabilityState,
  agent: string | null
): AgentSessionRegisteredAgent | undefined {
  const [agents, setAgents] = useState<{
    client: RpcClient
    generation: number | undefined
    rows: readonly AgentSessionRegisteredAgent[]
  } | null>(null)
  const generation = client?.getGeneration?.()
  const learned = agents?.client === client && agents?.generation === generation
  const wanted = !!client && host === 'supported' && !learned
  // Each attempt is one read; a failed read counts toward a few spaced retries.
  const [attempt, setAttempt] = useState({ count: 0, failures: 0 })
  useEffect(() => {
    if (!client || !wanted) {
      return
    }
    let cancelled = false
    void client
      .sendRequest(AGENT_SESSION_AGENTS_METHOD, {})
      .then((response) => (response.ok ? decodeAgentSessionAgentsResult(response.result) : null))
      .catch(() => null)
      .then((rows) => {
        if (cancelled) {
          return
        }
        if (rows) {
          setAgents({ client, generation, rows })
        } else {
          setAttempt((current) => ({ ...current, failures: current.failures + 1 }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, generation, wanted, attempt.count])
  // The action stays disabled while unread: a few spaced retries, then the next reconnect.
  const retryMs = wanted ? AGENTS_READ_RETRIES_MS[attempt.failures - 1] : undefined
  useEffect(() => {
    if (retryMs === undefined) {
      return
    }
    const timer = setTimeout(
      () => setAttempt((current) => ({ ...current, count: current.count + 1 })),
      retryMs
    )
    return () => clearTimeout(timer)
    // Armed once per failure: a retry's own read must not arm another timer.
  }, [retryMs])
  useEffect(() => {
    if (!client || !wanted) {
      return
    }
    return client.onStateChange((state) => {
      if (state === 'connected') {
        setAttempt((current) => ({ count: current.count + 1, failures: 0 }))
      }
    })
  }, [client, wanted])
  return learned ? agents.rows.find((row) => row.agent === agent) : undefined
}

export function useMobileNativeChatFork(input: {
  client: RpcClient | null
  hostCapabilities: readonly string[] | undefined
  agent: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  turnJournal: NativeChatTurnJournal | null
  agentWorking: boolean
  /** The chat's options read on its installed agent; the host's own discovery owns it. */
  sessionForkSupport: AgentSessionOptionsResult['forkSupport']
  createFork: (
    agent: AgentSessionHandleProvider,
    forkFrom: StructuredAgentSessionForkSource
  ) => Promise<void>
}): MobileNativeChatFork {
  const host: StructuredAgentSessionHostCapabilityState = !input.hostCapabilities
    ? 'unknown'
    : input.hostCapabilities.includes(AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  const registered = useRegisteredAgent(input.client, host, input.agent)
  const support = useMemo(
    () => nativeChatForkSupport(host, registered, input.sessionForkSupport),
    [host, registered, input.sessionForkSupport]
  )
  const { messages, turnJournal, agentWorking, sessionId, agent, createFork } = input
  const turns = useMemo(() => {
    const membership = nativeChatTurnMembership(messages, turnJournal)
    const keyById = new Map(
      messages.map((message, index) => [message.id, membership.turnKeys[index]])
    )
    return {
      keyById,
      liveTurnKey: membership.liveTurnKey,
      latestTurnKey: membership.turnKeys.findLast((key) => key !== undefined)
    }
  }, [messages, turnJournal])
  const contextFloorSequence = latestAgentSessionContextClearSequence(turnJournal?.items ?? [])
  // The sheet's row is a display projection; only one naming the agent's own message forks.
  const forkableItemIds = useMemo(
    () => nativeChatForkableItemIds(turnJournal?.items ?? []),
    [turnJournal]
  )
  // Reserved at the press, before any await, so a second press never starts a second fork.
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const offerFor = useCallback(
    (message: NativeChatMessage): MobileNativeChatForkOffer => {
      // Fixed by the row's own kind, never by support or turn state, so the meta row never shifts.
      if (
        message.role !== 'assistant' ||
        message.source !== 'transcript' ||
        message.agentStart ||
        !isRootAgentJournalItem(message)
      ) {
        return 'hidden'
      }
      const turnKey = turns.keyById.get(message.id)
      const offered =
        !!sessionId &&
        isAgentSessionHandleProvider(agent ?? '') &&
        nativeChatRowOffersFork(
          {
            message,
            inSubagentSection: false,
            turnWorking: agentWorking && (turnKey === undefined || turnKey === turns.liveTurnKey),
            inLatestTurn: turnKey !== undefined && turnKey === turns.latestTurnKey
          },
          { support, contextFloorSequence, forkableItemIds }
        )
      return !offered
        ? 'reserved'
        : pending || support.kind === 'unknown'
          ? 'disabled'
          : 'available'
    },
    [agent, agentWorking, contextFloorSequence, forkableItemIds, pending, sessionId, support, turns]
  )
  const fork = useCallback(
    (message: NativeChatMessage) => {
      if (
        inFlight.current ||
        offerFor(message) !== 'available' ||
        !sessionId ||
        !agent ||
        !isAgentSessionHandleProvider(agent)
      ) {
        return
      }
      inFlight.current = true
      setPending(true)
      void createFork(agent, { sessionId, throughItemId: message.id }).finally(() => {
        inFlight.current = false
        setPending(false)
      })
    },
    [agent, createFork, offerFor, sessionId]
  )
  // One stable value: each button re-renders only when its own offer changes, not on every
  // streamed revision of the transcript.
  const latest = useRef({ offerFor, fork })
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    latest.current = { offerFor, fork }
    for (const listener of listeners.current) {
      listener()
    }
  }, [offerFor, fork])
  return useMemo(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      offerFor: (message) => latest.current.offerFor(message),
      fork: (message) => latest.current.fork(message)
    }),
    []
  )
}
