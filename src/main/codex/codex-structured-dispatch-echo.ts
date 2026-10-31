import type { ProviderDiagnostic } from '../../shared/agent-session-failure'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'

export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256
// Retain turn outcomes for late answers and turns left unopened by a wait.
export const MAX_CODEX_RECORDED_TURN_ENDS = 64

export type CodexTurnEnd =
  | { status: 'completed' }
  | { status: 'interrupted' }
  | { status: 'failed'; detail?: ProviderDiagnostic; notSignedIn?: true }

export type CodexDispatchRequestOrigin = {
  requestedAt: number
  sequence: number
}

/** Key by client message ID: coalesced sends share turns and can echo out of order. */
export type CodexDispatchEchoes = {
  /** Receipt order of provider replies and notifications. */
  tick: () => number
  /** Record an answer or timeout that names no turn. */
  answered: (clientMessageId: string, at: number) => void
  /** Only status received after a no-turn answer determines whether that send is held. */
  observeStatus: (active: boolean) => void
  /** Sends still executing; ended turns release them even without an echo. */
  heldSends: () => ReadonlySet<string>
  /** False at capacity preserves older pending sends. */
  arm: (clientMessageId: string, requestedAt?: number) => boolean
  /** True once per armed send. */
  settle: (clientMessageId: string) => boolean
  /** Drops an armed send whose write never reached the provider. */
  disarm: (clientMessageId: string) => void
  /** Return an already-recorded turn end and settle the send if that end requires it. */
  bindTurn: (
    clientMessageId: string,
    threadId: string,
    turnId: string,
    via: AgentJournalTurnJoin,
    answeredAt?: number
  ) => CodexTurnEnd | null
  /** Latest answered turn eligible for its first open wait. */
  answeredUnopenedTurn: (threadId: string, openTurnIds: ReadonlySet<string>) => string | null
  /** Mark a timed-out open wait so later sends do not wait again. */
  leftUnopened: (threadId: string, turnId: string) => void
  opened: (threadId: string, turnId: string) => void
  /** An error naming a never-opened turn counts as its end. */
  hasOpened: (threadId: string, turnId: string) => boolean
  /** Latest answered turn still unopened after its wait was exhausted. */
  answeredTurnLeftUnopened: (threadId: string, openTurnIds: ReadonlySet<string>) => string | null
  /** Settle bound sends on failure or interruption; completed turns leave missing echoes for recovery. */
  endTurn: (
    threadId: string,
    turnId: string,
    end: CodexTurnEnd
  ) => { clientMessageId: string; via: AgentJournalTurnJoin }[]
  /** Submission origin retained while the send remains armed. */
  requestOrigin: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  /** A turn/start reply named the turn this send opened, recorded at reply receipt. */
  repliedTurn: (clientMessageId: string, threadId: string, turnId: string) => void
  /** Earliest armed send whose turn/start reply named this turn; hook-refused prompts never echo. */
  turnOpener: (
    threadId: string,
    turnId: string
  ) => { clientMessageId: string; requestOrigin: CodexDispatchRequestOrigin } | null
  latestSequence: () => number
  clear: () => void
  readonly size: number
}

export function createCodexDispatchEchoes(onHeldChange?: () => void): CodexDispatchEchoes {
  const armed = new Map<
    string,
    {
      requestedAt: number | null
      sequence: number
      turn?: { threadId: string; turnId: string; via: AgentJournalTurnJoin }
      openedTurn?: { threadId: string; turnId: string }
      answeredAt?: number
      turnEnded?: true
    }
  >()
  let clock = 0
  let status: { active: boolean; at: number } | null = null
  const heldSends = (): Set<string> =>
    new Set(
      [...armed].flatMap(([clientMessageId, entry]) =>
        entry.answeredAt === undefined ||
        (entry.turn
          ? entry.turnEnded !== true
          : status?.active === true && status.at > entry.answeredAt)
          ? [clientMessageId]
          : []
      )
    )
  const reporting = <T>(change: () => T): T => {
    if (!onHeldChange) {
      return change()
    }
    const before = [...heldSends()].join('\n')
    const result = change()
    if ([...heldSends()].join('\n') !== before) {
      onHeldChange()
    }
    return result
  }
  const endedTurns = new Map<string, CodexTurnEnd>()
  const unopenedTurns = new Set<string>()
  const openedTurns = new Set<string>()
  let nextSequence = 0
  const turnKey = (threadId: string, turnId: string): string => JSON.stringify([threadId, turnId])
  const settles = (end: CodexTurnEnd): boolean => end.status !== 'completed'
  const leftUnopened = (threadId: string, turnId: string): void => {
    unopenedTurns.add(turnKey(threadId, turnId))
    for (const oldest of unopenedTurns) {
      if (unopenedTurns.size <= MAX_CODEX_RECORDED_TURN_ENDS) {
        break
      }
      unopenedTurns.delete(oldest)
    }
  }
  const answeredTurn = (
    threadId: string,
    openTurnIds: ReadonlySet<string>,
    admits: (key: string) => boolean
  ): string | null => {
    const answered = [...armed.values()].flatMap(({ turn }) => {
      const key = turn?.threadId === threadId ? turnKey(threadId, turn.turnId) : null
      return turn && key && !openTurnIds.has(turn.turnId) && !endedTurns.has(key) && admits(key)
        ? [turn.turnId]
        : []
    })
    return answered.at(-1) ?? null
  }
  return {
    tick: () => ++clock,
    answered: (clientMessageId, at) =>
      reporting(() => {
        const entry = armed.get(clientMessageId)
        if (entry) {
          entry.answeredAt = at
        }
      }),
    observeStatus: (active) =>
      reporting(() => {
        status = { active, at: ++clock }
      }),
    heldSends,
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
      armed.set(clientMessageId, { requestedAt: requestedAt ?? null, sequence: nextSequence++ })
      return true
    },
    settle: (clientMessageId) => reporting(() => armed.delete(clientMessageId)),
    disarm: (clientMessageId) => reporting(() => void armed.delete(clientMessageId)),
    bindTurn: (clientMessageId, threadId, turnId, via, answeredAt) =>
      reporting(() => {
        const entry = armed.get(clientMessageId)
        if (!entry) {
          return null
        }
        entry.turn = { threadId, turnId, via }
        entry.answeredAt = answeredAt ?? ++clock
        const end = endedTurns.get(turnKey(threadId, turnId)) ?? null
        if (end) {
          entry.turnEnded = true
        }
        if (end && settles(end)) {
          armed.delete(clientMessageId)
        }
        return end
      }),
    answeredUnopenedTurn: (threadId, openTurnIds) =>
      answeredTurn(threadId, openTurnIds, (key) => !unopenedTurns.has(key)),
    answeredTurnLeftUnopened: (threadId, openTurnIds) =>
      answeredTurn(threadId, openTurnIds, (key) => unopenedTurns.has(key)),
    leftUnopened,
    opened: (threadId, turnId) => {
      openedTurns.add(turnKey(threadId, turnId))
      for (const oldest of openedTurns) {
        if (openedTurns.size <= MAX_CODEX_RECORDED_TURN_ENDS) {
          break
        }
        openedTurns.delete(oldest)
      }
    },
    hasOpened: (threadId, turnId) => openedTurns.has(turnKey(threadId, turnId)),
    endTurn: (threadId, turnId, end) =>
      reporting(() => {
        const turn = turnKey(threadId, turnId)
        endedTurns.delete(turn)
        endedTurns.set(turn, end)
        for (const oldest of endedTurns.keys()) {
          if (endedTurns.size <= MAX_CODEX_RECORDED_TURN_ENDS) {
            break
          }
          endedTurns.delete(oldest)
        }
        const bound = [...armed].flatMap(([clientMessageId, entry]) =>
          entry.turn && turnKey(entry.turn.threadId, entry.turn.turnId) === turn
            ? [{ clientMessageId, via: entry.turn.via, entry }]
            : []
        )
        // Completed turns echo accepted input first; missing echoes no longer count as held.
        for (const { entry } of bound) {
          entry.turnEnded = true
        }
        if (!settles(end)) {
          return []
        }
        for (const { clientMessageId } of bound) {
          armed.delete(clientMessageId)
        }
        return bound.map(({ clientMessageId, via }) => ({ clientMessageId, via }))
      }),
    requestOrigin: (clientMessageId) => {
      const origin = armed.get(clientMessageId)
      return origin?.requestedAt === null || origin === undefined
        ? null
        : { requestedAt: origin.requestedAt, sequence: origin.sequence }
    },
    repliedTurn: (clientMessageId, threadId, turnId) => {
      const entry = armed.get(clientMessageId)
      if (entry) {
        entry.openedTurn = { threadId, turnId }
      }
    },
    turnOpener: (threadId, turnId) => {
      // Sends are armed in sequence order, so the first match is the earliest.
      for (const [clientMessageId, { openedTurn, requestedAt, sequence }] of armed) {
        if (
          openedTurn?.threadId === threadId &&
          openedTurn.turnId === turnId &&
          requestedAt !== null
        ) {
          return { clientMessageId, requestOrigin: { requestedAt, sequence } }
        }
      }
      return null
    },
    latestSequence: () => nextSequence - 1,
    clear: () => {
      status = null
      armed.clear()
      endedTurns.clear()
      unopenedTurns.clear()
      openedTurns.clear()
      nextSequence = 0
    },
    get size() {
      return armed.size
    }
  }
}

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
