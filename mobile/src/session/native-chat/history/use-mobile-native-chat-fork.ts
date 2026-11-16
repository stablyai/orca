import { createContext, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  terminalForkReplyIds,
  terminalForkTurnEnd
} from '../../../../../src/shared/native-chat/terminal-fork-point'
import { AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY } from '../../../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import {
  AGENT_SESSION_CREATE_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
} from '../../../../../src/shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { latestAgentSessionContextClearSequence } from '../../../../../src/shared/agent-session/conversation-context/agent-session-context-clear'
import { isTuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentSessionForkSource } from '../../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../../src/shared/agent-session/capabilities/structured-agent-session-host-capability'
import type { ChatForkPreset } from '../../chat-fork/chat-fork-selection'
import {
  nativeChatForkInventory,
  nativeChatForkSupport,
  nativeChatRowOffersFork,
  type NativeChatForkSupport
} from '../../../../../src/shared/native-chat/transcript/turns/native-chat-fork-offer'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { isRootAgentJournalItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import {
  nativeChatTurnMembership,
  type NativeChatTurnJournal
} from '../../../../../src/shared/native-chat/transcript/turns/native-chat-turn-membership'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobileRegisteredAgent } from '../agent-session/use-mobile-registered-agent'

/** The fork a response offers: none, an empty held slot, drawn disabled, or pressable. */
export type MobileNativeChatForkOffer = 'hidden' | 'reserved' | 'disabled' | 'available'

/** Runs one fork from a response; the hook owns the single-fork-at-a-time gate around it. */
export type MobileNativeChatForkRun = (
  agent: TuiAgent,
  forkFrom: StructuredAgentSessionForkSource
) => Promise<void>

/** A copy of the chat's own history, or another agent's recap of it. */
export type MobileNativeChatForkKind = 'copy' | 'recap'

export type MobileNativeChatFork = {
  subscribe: (listener: () => void) => () => void
  offerFor: (message: NativeChatMessage) => MobileNativeChatForkOffer
  fork: (message: NativeChatMessage) => void
  /** Forks from this response through `run`; false when it can't fork now or one is running. */
  forkWith: (
    message: NativeChatMessage,
    run: MobileNativeChatForkRun,
    kind: MobileNativeChatForkKind
  ) => boolean
  /** Whether the same agent can take a copy of this chat; a recap needs only a finished reply. */
  copyOffered: () => boolean
  /** The newest response that can fork now. */
  latestForkable: () => NativeChatMessage | undefined
  /** Whether this host can fork a chat into a new worktree. */
  worktreeForkOffered: () => boolean
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

/** The chat's forks plus its Fork sheet, which every fork action opens. */
export type MobileNativeChatForkContextValue = MobileNativeChatFork & {
  openSheet: (message: NativeChatMessage, preset?: ChatForkPreset) => void
}

// A recap is built from the transcript itself, so any finished reply can start one.
const RECAP_SUPPORT: NativeChatForkSupport = { kind: 'known', fork: 'checkpoint' }

export const MobileNativeChatForkContext = createContext<MobileNativeChatForkContextValue | null>(
  null
)

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
  const worktreeForkSupported =
    input.hostCapabilities?.includes(AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY) ===
      true &&
    (input.terminal !== true ||
      input.hostCapabilities.includes(AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY))
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
  const { forkableItemIds, inheritedThroughSequence } = useMemo(
    () => nativeChatForkInventory(turnJournal?.items ?? []),
    [turnJournal]
  )
  const terminal = input.terminal === true
  // Copying a terminal chat cuts Claude's transcript on the host; a recap needs neither.
  const copyOffered = terminal
    ? agent === 'claude' &&
      input.hostCapabilities?.includes(AI_VAULT_TERMINAL_FORK_CUT_CAPABILITY) === true
    : support.kind !== 'none'
  // A terminal chat has no session journal: a reply ends where the next message is yours.
  const terminalForkPoints = useMemo(
    () => terminalForkReplyIds(messages, agentWorking),
    [agentWorking, messages]
  )
  // Reserved at the press, before any await, so a second press never starts a second fork.
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const offerOf = useCallback(
    (message: NativeChatMessage, kind: MobileNativeChatForkKind): MobileNativeChatForkOffer => {
      if (!mobileNativeChatRowHoldsForkSlot(message)) {
        return 'hidden'
      }
      if (terminal) {
        return !sessionId || !isTuiAgent(agent ?? '')
          ? 'hidden'
          : !terminalForkPoints.has(message.id)
            ? 'reserved'
            : pending
              ? 'disabled'
              : 'available'
      }
      const turnKey = turns.keyById.get(message.id)
      const rowSupport = kind === 'recap' ? RECAP_SUPPORT : support
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
          { support: rowSupport, contextFloorSequence, forkableItemIds, inheritedThroughSequence }
        )
      return !offered
        ? 'reserved'
        : pending || rowSupport.kind === 'unknown'
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
      turns
    ]
  )
  // Every fork action opens the sheet: a chat that can't be copied still offers a recap.
  const offerFor = useCallback(
    (message: NativeChatMessage): MobileNativeChatForkOffer =>
      offerOf(message, support.kind === 'none' ? 'recap' : 'copy'),
    [offerOf, support.kind]
  )
  const start = useCallback(
    (
      message: NativeChatMessage,
      create: MobileNativeChatForkRun,
      kind: MobileNativeChatForkKind
    ): boolean => {
      if (
        (kind === 'copy' && !copyOffered) ||
        inFlight.current ||
        offerOf(message, kind) !== 'available' ||
        !sessionId ||
        !agent ||
        !isTuiAgent(agent)
      ) {
        return false
      }
      inFlight.current = true
      setPending(true)
      // A terminal fork copies the reply's whole turn, tool work after its last text included.
      const throughItemId = terminal
        ? (terminalForkTurnEnd(messages, message.id) ?? message.id)
        : message.id
      // A run reports its own failures; a throw past it must still release the gate.
      void Promise.resolve()
        .then(() => create(agent, { sessionId, throughItemId }))
        .catch(() => undefined)
        .finally(() => {
          inFlight.current = false
          setPending(false)
        })
      return true
    },
    [agent, copyOffered, messages, offerOf, sessionId, terminal]
  )
  const fork = useCallback(
    (message: NativeChatMessage) => void start(message, createFork, 'copy'),
    [createFork, start]
  )
  const latestForkable = useCallback(
    () => messages.findLast((candidate) => offerFor(candidate) === 'available'),
    [messages, offerFor]
  )
  // One stable value: each button re-renders only when its own offer changes, not on every
  // streamed revision of the transcript.
  const latest = useRef({
    offerFor,
    fork,
    start,
    latestForkable,
    worktreeForkSupported,
    copyOffered,
    hostCapabilities: input.hostCapabilities
  })
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    latest.current = {
      offerFor,
      fork,
      start,
      latestForkable,
      worktreeForkSupported,
      copyOffered,
      hostCapabilities: input.hostCapabilities
    }
    for (const listener of listeners.current) {
      listener()
    }
  }, [
    offerFor,
    fork,
    start,
    latestForkable,
    worktreeForkSupported,
    copyOffered,
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
      forkWith: (message, run, kind) => latest.current.start(message, run, kind),
      copyOffered: () => latest.current.copyOffered,
      latestForkable: () => latest.current.latestForkable(),
      worktreeForkOffered: () => latest.current.worktreeForkSupported,
      hostCapabilities: () => latest.current.hostCapabilities
    }),
    []
  )
}
