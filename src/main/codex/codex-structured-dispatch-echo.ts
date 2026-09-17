import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLateSettlementResult } from '../native-chat/agent-session-wire/structured-agent-session-late-settlement'

/** Maximum sends awaiting an echo or exact owner-turn settlement. */
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256

export type CodexDispatchRequestOrigin = {
  requestedAt: number
  sequence: number
}

type PendingDispatch = {
  requestedAt: number | null
  sequence: number
  /** A `turn/start` response is ownership evidence only after this turn starts. */
  startCandidateTurnId: string | null
  ownerTurnId: string | null
  echoSettled: boolean
}

/**
 * Which sends this session is still waiting to hear back about, keyed by the
 * client message id Codex echoes on the user message.
 *
 * A successful `turn/steer` binds ownership atomically through expectedTurnId.
 * A fresh `turn/start` needs its response id plus a matching started or terminal
 * event; either response or started evidence alone can describe a phantom turn.
 */
export type CodexDispatchEchoes = {
  /** Tracks a send when capacity permits; false leaves it to echo/exit recovery. */
  arm: (clientMessageId: string, requestedAt?: number) => boolean
  /** Records one successful steer response, binding only the expected active turn. */
  bindSteerResponse: (
    clientMessageId: string,
    expectedTurnId: string,
    responseTurnId: string
  ) => boolean
  /** Records the proposed owner returned by `turn/start`. */
  recordStartResponse: (clientMessageId: string, responseTurnId: string) => void
  /** Supplies the second half of fresh-turn ownership evidence. */
  observeTurnStarted: (turnId: string) => void
  /** True once, for a send this session armed and has not yet settled. */
  settle: (clientMessageId: string) => boolean
  /** Snapshots exact owners before a terminal lifecycle append. */
  terminalOwnerIds: (turnId: string) => string[]
  /** Retires the snapshot after the lifecycle append commits. */
  commitTerminal: (turnId: string) => void
  /** Releases a snapshot whose lifecycle append was discarded. */
  abandonTerminal: (turnId: string) => void
  /** Drops an armed send whose write never reached the provider. */
  disarm: (clientMessageId: string) => void
  /** Submission origin for this exact send, retained until its echo settles it. */
  requestOrigin: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  /** Highest causal sequence assigned to a tracked dispatch in this session. */
  latestSequence: () => number
  clear: () => void
  readonly size: number
}

function rememberBounded(values: Set<string>, value: string): void {
  values.delete(value)
  values.add(value)
  while (values.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
    const oldest = values.values().next().value
    if (oldest === undefined) {
      return
    }
    values.delete(oldest)
  }
}

export function createCodexDispatchEchoes(
  onOwnerEndedLate?: (
    clientMessageId: string,
    turnId: string
  ) => void | Promise<StructuredAgentSessionLateSettlementResult>
): CodexDispatchEchoes {
  const armed = new Map<string, PendingDispatch>()
  const retired = new Map<string, PendingDispatch>()
  const startedTurns = new Set<string>()
  const terminalSnapshots = new Map<string, string[]>()
  let nextSequence = 0
  const rememberTerminalSnapshot = (turnId: string, snapshot: string[]): void => {
    terminalSnapshots.delete(turnId)
    terminalSnapshots.set(turnId, snapshot)
    while (terminalSnapshots.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
      const oldest = terminalSnapshots.keys().next().value
      if (oldest === undefined) {
        return
      }
      terminalSnapshots.delete(oldest)
    }
  }
  const hasUnbound = (): boolean => {
    for (const pending of armed.values()) {
      if (pending.ownerTurnId === null) {
        return true
      }
    }
    return false
  }
  const pruneObservedTurns = (): void => {
    if (!hasUnbound()) {
      startedTurns.clear()
    }
  }
  const rememberRetired = (clientMessageId: string, pending: PendingDispatch): void => {
    retired.delete(clientMessageId)
    retired.set(clientMessageId, pending)
    while (retired.size > MAX_CODEX_PENDING_DISPATCH_ECHOES) {
      const oldest = retired.keys().next().value
      if (oldest === undefined) {
        return
      }
      retired.delete(oldest)
    }
  }
  const settleOwnerEndedLate = (
    clientMessageId: string,
    turnId: string,
    pending: PendingDispatch
  ): void => {
    const settlement = onOwnerEndedLate?.(clientMessageId, turnId)
    if (!settlement) {
      return
    }
    void settlement.then(
      (outcome) => {
        if (
          outcome !== 'evidence-not-durable' &&
          armed.get(clientMessageId) === pending &&
          (pending.ownerTurnId === turnId || pending.startCandidateTurnId === turnId)
        ) {
          armed.delete(clientMessageId)
          rememberRetired(clientMessageId, pending)
          pruneObservedTurns()
        }
      },
      () => undefined
    )
  }
  const bindStartedCandidates = (turnId: string): void => {
    for (const pending of armed.values()) {
      if (pending.startCandidateTurnId === turnId) {
        pending.ownerTurnId = turnId
      }
    }
  }

  return {
    arm(clientMessageId, requestedAt) {
      const existing = armed.get(clientMessageId)
      if (existing) {
        if (existing.requestedAt === null && requestedAt !== undefined) {
          existing.requestedAt = requestedAt
        }
        return true
      }
      if (armed.size >= MAX_CODEX_PENDING_DISPATCH_ECHOES) {
        return false
      }
      retired.delete(clientMessageId)
      armed.set(clientMessageId, {
        requestedAt: requestedAt ?? null,
        sequence: nextSequence++,
        startCandidateTurnId: null,
        ownerTurnId: null,
        echoSettled: false
      })
      return true
    },
    bindSteerResponse(clientMessageId, expectedTurnId, responseTurnId) {
      const pending = armed.get(clientMessageId)
      if (!pending || responseTurnId !== expectedTurnId) {
        return false
      }
      if (pending.ownerTurnId === expectedTurnId && pending.startCandidateTurnId === null) {
        return true
      }
      pending.ownerTurnId = expectedTurnId
      pending.startCandidateTurnId = null
      // The host derives whether this response raced a durable terminal row.
      settleOwnerEndedLate(clientMessageId, expectedTurnId, pending)
      pruneObservedTurns()
      return true
    },
    recordStartResponse(clientMessageId, responseTurnId) {
      const pending = armed.get(clientMessageId)
      if (!pending) {
        return
      }
      if (pending.startCandidateTurnId === responseTurnId) {
        return
      }
      pending.startCandidateTurnId = responseTurnId
      pending.ownerTurnId = startedTurns.has(responseTurnId) ? responseTurnId : null
      // Terminal-before-response is proven by the durable host index, not a
      // bounded in-memory observation that can forget an older turn.
      settleOwnerEndedLate(clientMessageId, responseTurnId, pending)
      pruneObservedTurns()
    },
    observeTurnStarted(turnId) {
      rememberBounded(startedTurns, turnId)
      bindStartedCandidates(turnId)
      pruneObservedTurns()
    },
    settle(clientMessageId) {
      const pending = armed.get(clientMessageId) ?? retired.get(clientMessageId)
      if (!pending || pending.echoSettled) {
        return false
      }
      armed.delete(clientMessageId)
      pending.echoSettled = true
      rememberRetired(clientMessageId, pending)
      pruneObservedTurns()
      return true
    },
    terminalOwnerIds(turnId) {
      const priorSnapshot = terminalSnapshots.get(turnId)
      if (priorSnapshot) {
        return [...priorSnapshot]
      }
      const snapshot = [...armed].flatMap(([clientMessageId, pending]) =>
        pending.ownerTurnId === turnId || pending.startCandidateTurnId === turnId
          ? [clientMessageId]
          : []
      )
      startedTurns.delete(turnId)
      if (snapshot.length > 0) {
        rememberTerminalSnapshot(turnId, snapshot)
      }
      return [...snapshot]
    },
    commitTerminal(turnId) {
      for (const clientMessageId of terminalSnapshots.get(turnId) ?? []) {
        const pending = armed.get(clientMessageId)
        if (pending?.ownerTurnId === turnId || pending?.startCandidateTurnId === turnId) {
          armed.delete(clientMessageId)
          rememberRetired(clientMessageId, pending)
        }
      }
      terminalSnapshots.delete(turnId)
      pruneObservedTurns()
    },
    abandonTerminal(turnId) {
      terminalSnapshots.delete(turnId)
      pruneObservedTurns()
    },
    disarm(clientMessageId) {
      armed.delete(clientMessageId)
      retired.delete(clientMessageId)
      pruneObservedTurns()
    },
    requestOrigin(clientMessageId) {
      const origin = armed.get(clientMessageId) ?? retired.get(clientMessageId)
      return origin?.requestedAt === null || origin === undefined
        ? null
        : { requestedAt: origin.requestedAt, sequence: origin.sequence }
    },
    latestSequence: () => nextSequence - 1,
    clear: () => {
      armed.clear()
      retired.clear()
      startedTurns.clear()
      terminalSnapshots.clear()
      nextSequence = 0
    },
    get size() {
      return armed.size
    }
  }
}

/** The user-message echo a settlement is read off, or null for any other item. */
export function readCodexDispatchEcho(
  item: { type: string; id: string } & Record<string, unknown>,
  identity: AgentJournalItemIdentity
): { clientMessageId: string; providerIdentity: AgentJournalItemIdentity } | null {
  if (item.type !== 'userMessage' || identity.provider !== 'codex') {
    return null
  }
  const clientMessageId = item.clientId
  return typeof clientMessageId === 'string' && clientMessageId.length > 0
    ? { clientMessageId, providerIdentity: identity }
    : null
}
