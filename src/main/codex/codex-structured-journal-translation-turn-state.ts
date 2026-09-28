import type { AgentJournalTurnLifecycle } from '../../shared/agent-session-journal-types'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'

export const MAX_CODEX_ACTIVE_TURNS = 256
export const MAX_CODEX_ACTIVE_TURN_BYTES = 256 * 1024
export const MAX_CODEX_RECENT_TURNS = 256
export const MAX_CODEX_RECENT_TURN_BYTES = 256 * 1024

export type CodexJournalRequestOrigin = CodexDispatchRequestOrigin & { userItemId: string }

function earlierRequestOrigin(
  candidate: CodexJournalRequestOrigin,
  current: CodexJournalRequestOrigin | undefined
): boolean {
  return current === undefined || candidate.sequence < current.sequence
}

export class CodexJournalActiveTurns {
  /** Bounds active turn keys retained across provider threads. */
  static readonly MAX_ENTRIES = MAX_CODEX_ACTIVE_TURNS
  readonly byThread = new Map<string, Set<string>>()
  /** Host turn-start receipt per remembered turn; the terminal row carries it forward. */
  private readonly startedAtByTurn = new Map<string, number>()
  /** Earliest dispatched exact send per remembered turn, carried onto terminal rows. */
  private readonly requestOriginByTurn = new Map<string, CodexJournalRequestOrigin>()
  /** Last dispatch armed before each provider turn-start event. */
  private readonly latestDispatchSequenceByTurn = new Map<string, number>()
  private activeCount = 0
  private retainedBytes = 0

  get size(): number {
    return this.activeCount
  }

  get bytes(): number {
    return this.retainedBytes
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
  }

  private entryBytes(threadId: string, turnId: string): number {
    return Buffer.byteLength(threadId, 'utf8') + Buffer.byteLength(turnId, 'utf8')
  }

  canRemember(threadId: string, turnId: string): boolean {
    const active = this.byThread.get(threadId)
    return (
      active?.has(turnId) === true ||
      (this.activeCount < CodexJournalActiveTurns.MAX_ENTRIES &&
        this.retainedBytes + this.entryBytes(threadId, turnId) <= MAX_CODEX_ACTIVE_TURN_BYTES)
    )
  }

  current(threadId: string): string | null {
    return [...(this.byThread.get(threadId) ?? [])].at(-1) ?? null
  }

  /** Whether this turn is still open here. A terminal row already written carries
   *  the turn's start and duration, so a later end must not overwrite it. */
  isActive(threadId: string, turnId: string): boolean {
    return this.byThread.get(threadId)?.has(turnId) === true
  }

  startedAt(threadId: string, turnId: string): number | undefined {
    return this.startedAtByTurn.get(this.turnKey(threadId, turnId))
  }

  requestOrigin(threadId: string, turnId: string): CodexJournalRequestOrigin | undefined {
    return this.requestOriginByTurn.get(this.turnKey(threadId, turnId))
  }

  latestDispatchSequence(threadId: string, turnId: string): number | undefined {
    return this.latestDispatchSequenceByTurn.get(this.turnKey(threadId, turnId))
  }

  requestOriginRevision(
    threadId: string,
    turnId: string,
    requestOrigin: CodexJournalRequestOrigin
  ): { startedAt: number; requestedAt: number; userItemId: string } | null {
    const startedAt = this.startedAt(threadId, turnId)
    const latestDispatchSequence = this.latestDispatchSequence(threadId, turnId)
    if (
      startedAt === undefined ||
      latestDispatchSequence === undefined ||
      requestOrigin.sequence > latestDispatchSequence
    ) {
      return null
    }
    const current = this.requestOrigin(threadId, turnId)
    return earlierRequestOrigin(requestOrigin, current)
      ? {
          startedAt,
          requestedAt: requestOrigin.requestedAt,
          userItemId: requestOrigin.userItemId
        }
      : null
  }

  rememberRequestOrigin(
    threadId: string,
    turnId: string,
    requestOrigin: CodexJournalRequestOrigin
  ): void {
    if (this.byThread.get(threadId)?.has(turnId)) {
      this.requestOriginByTurn.set(this.turnKey(threadId, turnId), requestOrigin)
    }
  }

  remember(
    threadId: string,
    turnId: string,
    startedAt?: number,
    latestDispatchSequence = Number.MAX_SAFE_INTEGER
  ): boolean {
    const active = this.byThread.get(threadId)
    if (active?.has(turnId)) {
      return true
    }
    if (!this.canRemember(threadId, turnId)) {
      return false
    }
    if (startedAt !== undefined) {
      this.startedAtByTurn.set(this.turnKey(threadId, turnId), startedAt)
    }
    this.latestDispatchSequenceByTurn.set(this.turnKey(threadId, turnId), latestDispatchSequence)
    if (active) {
      active.add(turnId)
    } else {
      this.byThread.set(threadId, new Set([turnId]))
    }
    this.activeCount += 1
    this.retainedBytes += this.entryBytes(threadId, turnId)
    return true
  }

  forget(threadId: string, turnId: string): void {
    this.startedAtByTurn.delete(this.turnKey(threadId, turnId))
    this.requestOriginByTurn.delete(this.turnKey(threadId, turnId))
    this.latestDispatchSequenceByTurn.delete(this.turnKey(threadId, turnId))
    const active = this.byThread.get(threadId)
    if (active?.delete(turnId)) {
      this.activeCount -= 1
      this.retainedBytes = Math.max(0, this.retainedBytes - this.entryBytes(threadId, turnId))
    }
    if (!active?.size) {
      this.byThread.delete(threadId)
    }
  }

  clear(): void {
    this.byThread.clear()
    this.startedAtByTurn.clear()
    this.requestOriginByTurn.clear()
    this.latestDispatchSequenceByTurn.clear()
    this.activeCount = 0
    this.retainedBytes = 0
  }
}

type RecentTurn = {
  lifecycle: AgentJournalTurnLifecycle
  requestOrigin?: CodexJournalRequestOrigin
  latestDispatchSequence: number
  bytes: number
}

/** Bounded terminal lifecycle window for exact echoes that arrive after completion. */
export class CodexJournalRecentTurns {
  private readonly turns = new Map<string, RecentTurn>()
  private retainedBytes = 0

  get size(): number {
    return this.turns.size
  }

  get bytes(): number {
    return this.retainedBytes
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
  }

  remember(
    threadId: string,
    lifecycle: AgentJournalTurnLifecycle,
    requestOrigin?: CodexJournalRequestOrigin,
    latestDispatchSequence?: number
  ): void {
    const key = this.turnKey(threadId, lifecycle.turnId)
    const existing = this.turns.get(key)
    if (existing) {
      this.retainedBytes -= existing.bytes
      this.turns.delete(key)
    }
    const causalSequence =
      latestDispatchSequence ?? existing?.latestDispatchSequence ?? Number.MAX_SAFE_INTEGER
    const bytes = Buffer.byteLength(
      JSON.stringify({
        threadId,
        lifecycle,
        requestOrigin,
        latestDispatchSequence: causalSequence
      }),
      'utf8'
    )
    if (bytes > MAX_CODEX_RECENT_TURN_BYTES) {
      return
    }
    this.turns.set(key, {
      lifecycle,
      ...(requestOrigin ? { requestOrigin } : {}),
      latestDispatchSequence: causalSequence,
      bytes
    })
    this.retainedBytes += bytes
    while (
      this.turns.size > MAX_CODEX_RECENT_TURNS ||
      this.retainedBytes > MAX_CODEX_RECENT_TURN_BYTES
    ) {
      const oldest = this.turns.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const removed = this.turns.get(oldest)
      this.turns.delete(oldest)
      this.retainedBytes = Math.max(0, this.retainedBytes - (removed?.bytes ?? 0))
    }
  }

  requestOriginRevision(
    threadId: string,
    turnId: string,
    requestOrigin: CodexJournalRequestOrigin
  ): AgentJournalTurnLifecycle | null {
    const current = this.turns.get(this.turnKey(threadId, turnId))
    const startedAt = current?.lifecycle.startedAt
    if (
      !current ||
      startedAt === undefined ||
      requestOrigin.sequence > current.latestDispatchSequence ||
      !earlierRequestOrigin(requestOrigin, current.requestOrigin)
    ) {
      return null
    }
    return {
      ...current.lifecycle,
      requestedAt: requestOrigin.requestedAt,
      userItemId: requestOrigin.userItemId
    }
  }

  clear(): void {
    this.turns.clear()
    this.retainedBytes = 0
  }
}
