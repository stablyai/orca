import { AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY } from '../../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import { useRegisteredAgent } from './use-mobile-registered-fork-agent'
import type { MobileWorktreeForkMode } from '../mobile-structured-chat-worktree-fork'
import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionOptionsResult } from '../../../../src/shared/agent-session/options/agent-session-options-result'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
} from '../../../../src/shared/agent-session/agent-session-create-capabilities'
import { latestAgentSessionContextClearSequence } from '../../../../src/shared/agent-session/agent-session-context-clear'
import { isTuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/structured-agent-session-create'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../src/shared/agent-session/structured-agent-session-host-capability'
import {
  nativeChatForkInventory,
  nativeChatForkSupport,
  nativeChatRowOffersFork
} from '../../../../src/shared/native-chat/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { isRootAgentJournalItem } from '../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../src/shared/native-chat/transcript/native-chat-turn-membership'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

/** The fork a response offers: none, an empty held slot, drawn disabled, or pressable. */
export type MobileNativeChatForkOffer = 'hidden' | 'reserved' | 'disabled' | 'available'

export type MobileNativeChatFork = {
  subscribe: (listener: () => void) => () => void
  offerFor: (message: NativeChatMessage) => MobileNativeChatForkOffer
  fork: (message: NativeChatMessage) => void
  /** Whether this host can fork a chat into a new worktree. */
  worktreeForkOffered: () => boolean
  forkToWorktree: (message: NativeChatMessage, mode?: MobileWorktreeForkMode) => void
  /** Forks the newest response that can fork into a new worktree; false when none can. */
  forkLatestToWorktree: (mode?: MobileWorktreeForkMode) => boolean
  hostCapabilities: () => readonly string[] | undefined
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
  /** A terminal chat: forks cut its own transcript on the host, offered on each finished reply. */
  terminal?: boolean
  createWorktreeFork: (
    agent: TuiAgent,
    forkFrom: StructuredAgentSessionForkSource,
    mode: MobileWorktreeForkMode
  ) => Promise<void>
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
  const registered = useRegisteredAgent(input.client, host, input.agent)
  const support = useMemo(
    () => nativeChatForkSupport(host, registered, input.sessionForkSupport, inheritedOriginal),
    [host, registered, input.sessionForkSupport, inheritedOriginal]
  )
  const worktreeForkSupported =
    input.hostCapabilities?.includes(AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY) ===
      true &&
    (input.terminal !== true ||
      input.hostCapabilities.includes(AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY))
  const { messages, turnJournal, agentWorking, sessionId, agent, createFork, createWorktreeFork } =
    input
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
  const { forkableItemIds, inheritedThroughSequence } = useMemo(
    () => nativeChatForkInventory(turnJournal?.items ?? []),
    [turnJournal]
  )
  const terminal = input.terminal === true
  const terminalForkSupported =
    terminal && input.hostCapabilities?.includes(AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY) === true
  // A terminal chat has no session journal: a reply ends where the next message is yours.
  const terminalForkPoints = useMemo(() => {
    const ids = new Set<string>()
    messages.forEach((message, index) => {
      const next = messages[index + 1]
      const last = index === messages.length - 1
      if (
        message.role === 'assistant' &&
        message.source === 'transcript' &&
        !message.agentStart &&
        (next ? next.role === 'user' : !agentWorking) &&
        (!last || !agentWorking)
      ) {
        ids.add(message.id)
      }
    })
    return ids
  }, [agentWorking, messages])
  // Reserved at the press, before any await, so a second press never starts a second fork.
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const offerFor = useCallback(
    (message: NativeChatMessage): MobileNativeChatForkOffer => {
      if (!mobileNativeChatRowHoldsForkSlot(message)) {
        return 'hidden'
      }
      if (terminal) {
        return !terminalForkSupported || !sessionId || agent !== 'claude'
          ? 'hidden'
          : !terminalForkPoints.has(message.id)
            ? 'reserved'
            : pending
              ? 'disabled'
              : 'available'
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
      terminal,
      terminalForkPoints,
      terminalForkSupported,
      turns
    ]
  )
  const start = useCallback(
    (message: NativeChatMessage, create: typeof createFork): boolean => {
      if (
        inFlight.current ||
        offerFor(message) !== 'available' ||
        !sessionId ||
        !agent ||
        !isTuiAgent(agent)
      ) {
        return false
      }
      inFlight.current = true
      setPending(true)
      void create(agent, { sessionId, throughItemId: message.id }).finally(() => {
        inFlight.current = false
        setPending(false)
      })
      return true
    },
    [agent, offerFor, sessionId]
  )
  const fork = useCallback(
    (message: NativeChatMessage) => void start(message, createFork),
    [createFork, start]
  )
  const forkToWorktree = useCallback(
    (message: NativeChatMessage, mode: MobileWorktreeForkMode = 'worktree') => {
      if (worktreeForkSupported) {
        start(message, (forkAgent, forkFrom) => createWorktreeFork(forkAgent, forkFrom, mode))
      }
    },
    [createWorktreeFork, start, worktreeForkSupported]
  )
  const forkLatestToWorktree = useCallback(
    (mode: MobileWorktreeForkMode = 'worktree'): boolean => {
      const message = messages.findLast((candidate) => offerFor(candidate) === 'available')
      return (
        worktreeForkSupported &&
        !!message &&
        start(message, (forkAgent, forkFrom) => createWorktreeFork(forkAgent, forkFrom, mode))
      )
    },
    [createWorktreeFork, messages, offerFor, start, worktreeForkSupported]
  )
  // One stable value: each button re-renders only when its own offer changes, not on every
  // streamed revision of the transcript.
  const latest = useRef({
    offerFor,
    fork,
    forkToWorktree,
    forkLatestToWorktree,
    worktreeForkSupported,
    hostCapabilities: input.hostCapabilities
  })
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    latest.current = {
      offerFor,
      fork,
      forkToWorktree,
      forkLatestToWorktree,
      worktreeForkSupported,
      hostCapabilities: input.hostCapabilities
    }
    for (const listener of listeners.current) {
      listener()
    }
  }, [
    offerFor,
    fork,
    forkToWorktree,
    forkLatestToWorktree,
    worktreeForkSupported,
    input.hostCapabilities
  ])
  return useMemo(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      offerFor: (message) => latest.current.offerFor(message),
      fork: (message) => latest.current.fork(message),
      worktreeForkOffered: () => latest.current.worktreeForkSupported,
      forkToWorktree: (message, mode) => latest.current.forkToWorktree(message, mode),
      forkLatestToWorktree: (mode) => latest.current.forkLatestToWorktree(mode),
      hostCapabilities: () => latest.current.hostCapabilities
    }),
    []
  )
}
