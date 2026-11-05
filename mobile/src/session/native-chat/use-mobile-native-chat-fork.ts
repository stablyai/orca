import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENT_SESSION_AGENTS_METHOD,
  decodeAgentSessionAgentsResult,
  type AgentSessionRegisteredAgent
} from '../../../../src/shared/agent-session/agent-session-registered-agents'
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
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import type { RpcClient } from '../../transport/rpc-client'

/** The fork a message's actions sheet offers: hidden, drawn disabled, or pressable. */
export type MobileNativeChatForkOffer = 'hidden' | 'disabled' | 'available'

export type MobileNativeChatFork = {
  offerFor: (message: NativeChatMessage) => MobileNativeChatForkOffer
  fork: (message: NativeChatMessage) => void
}

export const MobileNativeChatForkContext = createContext<MobileNativeChatFork | null>(null)

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
  useEffect(() => {
    if (!client || host !== 'supported' || learned) {
      return
    }
    let cancelled = false
    void client
      .sendRequest(AGENT_SESSION_AGENTS_METHOD, {})
      .then((response) => {
        const rows = response.ok ? decodeAgentSessionAgentsResult(response.result) : null
        if (!cancelled && rows) {
          setAgents({ client, generation, rows })
        }
      })
      // An unread list leaves the action disabled; the next connection asks again.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, generation, host, learned])
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
  createFork: (
    agent: AgentSessionHandleProvider,
    forkFrom: StructuredAgentSessionForkSource
  ) => Promise<void>
}): MobileNativeChatFork | null {
  const host: StructuredAgentSessionHostCapabilityState = !input.hostCapabilities
    ? 'unknown'
    : input.hostCapabilities.includes(AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  const registered = useRegisteredAgent(input.client, host, input.agent)
  const support = useMemo(() => nativeChatForkSupport(host, registered), [host, registered])
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
      return !offered ? 'hidden' : pending || support.kind === 'unknown' ? 'disabled' : 'available'
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
  return useMemo(
    () => (support.kind === 'none' ? null : { offerFor, fork }),
    [fork, offerFor, support.kind]
  )
}
