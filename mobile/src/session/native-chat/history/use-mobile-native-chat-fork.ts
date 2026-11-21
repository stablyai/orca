import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { latestAgentSessionContextClearSequence } from '../../../../../src/shared/agent-session/conversation-context/agent-session-context-clear'
import { isTuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../../src/shared/agent-session/capabilities/structured-agent-session-host-capability'
import {
  nativeChatForkInventory,
  nativeChatForkSupport,
  nativeChatRowOffersFork
} from '../../../../../src/shared/native-chat/transcript/turns/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { isRootAgentJournalItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobileRegisteredAgent } from '../agent-session/use-mobile-registered-agent'
import { projectionBesideStreamedText } from '../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'

/** The fork a response offers: none, an empty held slot, drawn disabled, or pressable. */
export type MobileNativeChatForkOffer = 'hidden' | 'reserved' | 'disabled' | 'available'

/** What `/fork` did: opened a fork, waited on one already opening, or found no response to copy. */
export type MobileNativeChatForkLatestOutcome = 'started' | 'pending' | 'working' | 'none'

export type MobileNativeChatFork = {
  subscribe: (listener: () => void) => () => void
  offerFor: (message: NativeChatMessage) => MobileNativeChatForkOffer
  fork: (message: NativeChatMessage) => void
  /** Whether `/fork` is Orca's here: the host and agent confirmed they can fork, as on desktop. */
  commandOffered: () => boolean
  /** `/fork`: copies through the newest response that offers a fork, as desktop's command does. */
  forkLatest: () => MobileNativeChatForkLatestOutcome
}

/** Fixed by the row's own kind, never by support or turn state, so the meta row never shifts. */
export function mobileNativeChatRowHoldsForkSlot(message: NativeChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.source === 'transcript' &&
    !message.agentStart &&
    isRootAgentJournalItem(message)
  )
}

export const MobileNativeChatForkContext = createContext<MobileNativeChatFork | null>(null)

export function useMobileNativeChatFork(input: {
  client: RpcClient | null
  hostCapabilities: readonly string[] | undefined
  hostStatusPending: boolean
  agent: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  turnJournal: NativeChatTurnJournal | null
  agentWorking: boolean
  /** The chat's options read on its installed agent; the host's own discovery owns it. */
  sessionForkSupport: AgentSessionOptionsResult['forkSupport']
  createFork: (agent: TuiAgent, forkFrom: StructuredAgentSessionForkSource) => Promise<void>
}): MobileNativeChatFork {
  const host: StructuredAgentSessionHostCapabilityState = !input.hostCapabilities
    ? 'unknown'
    : input.hostCapabilities.includes(AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY)
      ? 'supported'
      : 'unsupported'
  const inheritedOriginal: StructuredAgentSessionHostCapabilityState =
    !input.hostCapabilities || input.hostStatusPending
      ? 'unknown'
      : input.hostCapabilities.includes(AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY)
        ? 'supported'
        : 'unsupported'
  const registered = useMobileRegisteredAgent(input.client, host === 'supported', input.agent)
  const support = useMemo(
    () => nativeChatForkSupport(host, registered, input.sessionForkSupport, inheritedOriginal),
    [host, registered, input.sessionForkSupport, inheritedOriginal]
  )
  const { messages, turnJournal, agentWorking, sessionId, agent, createFork } = input
  // Turn keys read message ids and turns, never reply text, so they hold while a reply streams.
  const structure = projectionBesideStreamedText(messages)
  const turns = useMemo(() => {
    const membership = nativeChatTurnMembership(structure, turnJournal)
    const keyById = new Map(
      structure.map((message, index) => [message.id, membership.turnKeys[index]])
    )
    return {
      keyById,
      liveTurnKey: membership.liveTurnKey,
      latestTurnKey: membership.turnKeys.findLast((key) => key !== undefined)
    }
  }, [structure, turnJournal])
  const contextFloorSequence = latestAgentSessionContextClearSequence(turnJournal?.items ?? [])
  // The sheet's row is a display projection; only one naming the agent's own message forks.
  const { forkableItemIds, inheritedThroughSequence } = useMemo(
    () => nativeChatForkInventory(turnJournal?.items ?? []),
    [turnJournal]
  )
  // Reserved at the press, before any await, so a second press never starts a second fork.
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const offerFor = useCallback(
    (message: NativeChatMessage): MobileNativeChatForkOffer => {
      if (!mobileNativeChatRowHoldsForkSlot(message)) {
        return 'hidden'
      }
      const turnKey = turns.keyById.get(message.id)
      const offered =
        !!sessionId &&
        isTuiAgent(agent ?? '') &&
        nativeChatRowOffersFork(
          {
            message,
            inSubagentSection: false,
            turnWorking: agentWorking && (turnKey === undefined || turnKey === turns.liveTurnKey),
            inLatestTurn: turnKey !== undefined && turnKey === turns.latestTurnKey
          },
          { support, contextFloorSequence, forkableItemIds, inheritedThroughSequence }
        )
      return !offered
        ? 'reserved'
        : pending || support.kind === 'unknown'
          ? 'disabled'
          : 'available'
    },
    [
      agent,
      agentWorking,
      contextFloorSequence,
      forkableItemIds,
      inheritedThroughSequence,
      pending,
      sessionId,
      support,
      turns
    ]
  )
  const fork = useCallback(
    (message: NativeChatMessage) => {
      if (
        inFlight.current ||
        offerFor(message) !== 'available' ||
        !sessionId ||
        !agent ||
        !isTuiAgent(agent)
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
  const commandOffered = useCallback(
    () => support.kind === 'known' && !!sessionId && isTuiAgent(agent ?? ''),
    [agent, sessionId, support]
  )
  const forkLatest = useCallback((): MobileNativeChatForkLatestOutcome => {
    if (inFlight.current) {
      return 'pending'
    }
    const through = messages.findLast((message) => offerFor(message) === 'available')
    if (!through) {
      return agentWorking ? 'working' : 'none'
    }
    fork(through)
    return 'started'
  }, [agentWorking, fork, messages, offerFor])
  // One stable value: each button re-renders only when its own offer changes, not on every
  // streamed revision of the transcript.
  const latest = useRef({ offerFor, fork, commandOffered, forkLatest })
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    latest.current = { offerFor, fork, commandOffered, forkLatest }
    for (const listener of listeners.current) {
      listener()
    }
  }, [offerFor, fork, commandOffered, forkLatest])
  return useMemo(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      offerFor: (message) => latest.current.offerFor(message),
      fork: (message) => latest.current.fork(message),
      commandOffered: () => latest.current.commandOffered(),
      forkLatest: () => latest.current.forkLatest()
    }),
    []
  )
}
