import type { ProviderDiagnostic } from '../../shared/agent-session-failure'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnJoin
} from '../../shared/agent-session-journal-types'

/** Sends awaiting their echo. One bound to a turn that ended without taking it settles from that
 *  end; any other whose echo never arrives is retired by the journal's recovery on exit. */
export const MAX_CODEX_PENDING_DISPATCH_ECHOES = 256
/** Turn ends kept for an answer read after the turn it names had already ended, and answered
 *  turns kept that Codex left unopened through a wait. */
export const MAX_CODEX_RECORDED_TURN_ENDS = 64

/** How a primary-thread turn ended, as Codex reported it. */
export type CodexTurnEnd =
  | { status: 'completed' }
  | { status: 'interrupted' }
  | { status: 'failed'; detail?: ProviderDiagnostic; notSignedIn?: true }

export type CodexDispatchRequestOrigin = {
  requestedAt: number
  sequence: number
}

/**
 * Which sends this session is still waiting to hear back about, keyed by the
 * client message id Codex echoes on the user message.
 *
 * Keyed rather than ordered on purpose: Codex coalesces a `turn/start` issued
 * while a turn is running into that turn, so two sends can share one turn id and
 * their echoes arrive far apart. Queue position identifies neither.
 */
export type CodexDispatchEchoes = {
  /** A point in the order Codex's replies and notifications are read in: `onReply` and
   *  `observeStatus` stamp from it as they read, so a stamp orders what arrived, not what ran. */
  tick: () => number
  /** Codex answered this send (or its request timed out, `at`) without naming a turn. */
  answered: (clientMessageId: string, at: number) => void
  /** The primary thread's reported status, as read: only one read after a send's answer decides
   *  whether Codex still works on a send it answered into no turn. */
  observeStatus: (active: boolean) => void
  /** The sends Codex still holds: unanswered, answered into a turn that has not ended, or answered
   *  into none while the thread reported running since. Execution, never delivery: an ended turn
   *  releases a send whether or not its echo came. */
  heldSends: () => ReadonlySet<string>
  /** Arms settlement for a send about to be written; false preserves older waits at capacity. */
  arm: (clientMessageId: string, requestedAt?: number) => boolean
  /** True once, for a send this session armed and has not yet settled. */
  settle: (clientMessageId: string) => boolean
  /** Drops an armed send whose write never reached the provider. */
  disarm: (clientMessageId: string) => void
  /**
   * Binds a send to the turn Codex answered it into, and how it joined that turn. Returns that
   * turn's end when the answer is read after it; a send that end settles is no longer armed.
   */
  bindTurn: (
    clientMessageId: string,
    threadId: string,
    turnId: string,
    via: AgentJournalTurnJoin,
    answeredAt?: number
  ) => CodexTurnEnd | null
  /** The turn the latest armed send was answered into that is neither in `openTurnIds`, ended, nor
   *  left unopened through a wait: one Codex has picked for the send but not opened. */
  answeredUnopenedTurn: (threadId: string, openTurnIds: ReadonlySet<string>) => string | null
  /** Codex did not open this answered turn within a wait, so no later wait is spent on it. */
  leftUnopened: (threadId: string, turnId: string) => void
  /** Codex opened this turn, by its `turn/started`. */
  opened: (threadId: string, turnId: string) => void
  /** Whether Codex opened this turn: an `error` naming one it never opened is that turn's end. */
  hasOpened: (threadId: string, turnId: string) => boolean
  /** The latest armed send's answered turn a wait left unopened, neither open nor ended: Codex may
   *  still open it, though no wait is spent on it again. */
  answeredTurnLeftUnopened: (threadId: string, openTurnIds: ReadonlySet<string>) => string | null
  /**
   * Records a turn's end and returns the sends bound to it that it settles: all of them unless it
   * completed, which echoes its pending input first, so one it never echoed waits for recovery. An
   * interrupt withdraws an un-echoed send, steered or the turn's own input: neither reached history.
   */
  endTurn: (
    threadId: string,
    turnId: string,
    end: CodexTurnEnd
  ) => { clientMessageId: string; via: AgentJournalTurnJoin }[]
  /** Submission origin for this exact send, retained until its echo settles it. */
  requestOrigin: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  /** Highest causal sequence assigned to a dispatch in this session. */
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
  /** Runs a change and reports it when the sends Codex holds changed with it. */
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
        // A completed turn echoed what it took first, so one it never echoed is no longer Codex's.
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
