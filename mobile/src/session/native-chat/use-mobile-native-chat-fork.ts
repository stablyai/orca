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
  forkToWorktree: (message: NativeChatMessage) => void
  /** Forks the newest response that can fork into a new worktree; false when none can. */
  forkLatestToWorktree: () => boolean
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

const AGENTS_READ_RETRIES_MS = [2_000, 8_000, 30_000]

/** One stretch of discovery: a client, its generation, and one supported, unlearned spell. Its
 *  reads, failures and retry timer die with it, so a new stretch starts with every retry. */
type Discovery = {
  client: RpcClient | null
  generation: number | undefined
  wanted: boolean
  id: number
  count: number
  failures: number
}

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
  const [stored, setDiscovery] = useState<Discovery>({
    client,
    generation,
    wanted,
    id: 0,
    count: 0,
    failures: 0
  })
  let discovery = stored
  if (stored.client !== client || stored.generation !== generation || stored.wanted !== wanted) {
    // A new stretch, false ones included, so resuming never reuses an earlier budget.
    discovery = { client, generation, wanted, id: stored.id + 1, count: 0, failures: 0 }
    setDiscovery(discovery)
  }
  const { id } = discovery
  // Updates from an earlier stretch's read, timer or listener change nothing.
  const update = useCallback(
    (next: (current: Discovery) => Pick<Discovery, 'count' | 'failures'>) =>
      setDiscovery((current) => (current.id === id ? { ...current, ...next(current) } : current)),
    [id]
  )
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
          update((current) => ({ count: current.count, failures: current.failures + 1 }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, generation, wanted, update, discovery.count])
  // The action stays disabled while unread: a few spaced retries, then the next reconnect.
  const retryMs = wanted ? AGENTS_READ_RETRIES_MS[discovery.failures - 1] : undefined
  useEffect(() => {
    if (retryMs === undefined) {
      return
    }
    const timer = setTimeout(
      () => update((current) => ({ count: current.count + 1, failures: current.failures })),
      retryMs
    )
    return () => clearTimeout(timer)
    // One timer per failure of this stretch; a retry's own read must not arm another.
  }, [update, retryMs, discovery.failures])
  useEffect(() => {
    if (!client || !wanted) {
      return
    }
    return client.onStateChange((state) => {
      if (state === 'connected') {
        update((current) => ({ count: current.count + 1, failures: 0 }))
      }
    })
  }, [client, wanted, update])
  return learned ? agents.rows.find((row) => row.agent === agent) : undefined
}

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
  createWorktreeFork: (agent: TuiAgent, forkFrom: StructuredAgentSessionForkSource) => Promise<void>
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
    input.hostCapabilities?.includes(AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY) === true
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
    (message: NativeChatMessage) => {
      if (worktreeForkSupported) {
        start(message, createWorktreeFork)
      }
    },
    [createWorktreeFork, start, worktreeForkSupported]
  )
  const forkLatestToWorktree = useCallback((): boolean => {
    const message = messages.findLast((candidate) => offerFor(candidate) === 'available')
    return worktreeForkSupported && !!message && start(message, createWorktreeFork)
  }, [createWorktreeFork, messages, offerFor, start, worktreeForkSupported])
  // One stable value: each button re-renders only when its own offer changes, not on every
  // streamed revision of the transcript.
  const latest = useRef({
    offerFor,
    fork,
    forkToWorktree,
    forkLatestToWorktree,
    worktreeForkSupported
  })
  const listeners = useRef(new Set<() => void>())
  useLayoutEffect(() => {
    latest.current = { offerFor, fork, forkToWorktree, forkLatestToWorktree, worktreeForkSupported }
    for (const listener of listeners.current) {
      listener()
    }
  }, [offerFor, fork, forkToWorktree, forkLatestToWorktree, worktreeForkSupported])
  return useMemo(
    () => ({
      subscribe: (listener) => {
        listeners.current.add(listener)
        return () => listeners.current.delete(listener)
      },
      offerFor: (message) => latest.current.offerFor(message),
      fork: (message) => latest.current.fork(message),
      worktreeForkOffered: () => latest.current.worktreeForkSupported,
      forkToWorktree: (message) => latest.current.forkToWorktree(message),
      forkLatestToWorktree: () => latest.current.forkLatestToWorktree()
    }),
    []
  )
}
