import type { AgentJournalTurnLifecycle } from '../../shared/agent-session-journal-types'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'

export const MAX_CODEX_RECENT_TURNS = 256
export const MAX_CODEX_RECENT_TURN_BYTES = 256 * 1024

export type CodexJournalRequestOrigin = CodexDispatchRequestOrigin & { userItemId: string }

export function earlierRequestOrigin(
  candidate: CodexJournalRequestOrigin,
  current: CodexJournalRequestOrigin | undefined
): boolean {
  return current === undefined || candidate.sequence < current.sequence
}

export class CodexJournalActiveTurns {
  readonly byThread = new Map<string, Set<string>>()
  /** Host receipt time, retained on terminal rows. */
  private readonly startedAtByTurn = new Map<string, number>()
  /** Earliest exact dispatch echo, retained on terminal rows. */
  private readonly requestOriginByTurn = new Map<string, CodexJournalRequestOrigin>()
  /** Last dispatch armed before each provider turn-start event. */
  private readonly latestDispatchSequenceByTurn = new Map<string, number>()

  private turnKey(threadId: string, turnId: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(turnId)}`
  }

  current(threadId: string): string | null {
    return [...(this.byThread.get(threadId) ?? [])].at(-1) ?? null
  }

  has(threadId: string, turnId: string): boolean {
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
  ): void {
    const active = this.byThread.get(threadId)
    if (active?.has(turnId)) {
      return
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
  }

  forget(threadId: string, turnId: string): void {
    this.startedAtByTurn.delete(this.turnKey(threadId, turnId))
    this.requestOriginByTurn.delete(this.turnKey(threadId, turnId))
    this.latestDispatchSequenceByTurn.delete(this.turnKey(threadId, turnId))
    const active = this.byThread.get(threadId)
    active?.delete(turnId)
    if (!active?.size) {
      this.byThread.delete(threadId)
    }
  }

  clear(): void {
    this.byThread.clear()
    this.startedAtByTurn.clear()
    this.requestOriginByTurn.clear()
    this.latestDispatchSequenceByTurn.clear()
  }
}

type RecentTurn = {
  lifecycle: AgentJournalTurnLifecycle
  requestOrigin?: CodexJournalRequestOrigin
  latestDispatchSequence: number
  bytes: number
}

/** Retain terminal rows within bounds for late dispatch echoes. */
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
