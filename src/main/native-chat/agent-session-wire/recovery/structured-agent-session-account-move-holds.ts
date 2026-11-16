// Chats whose person-sent work waits for an account move, and the edges that may end the wait.

import type {
  StructuredAgentSessionAccountMoveEdge,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAccountTransition } from './structured-agent-session-outgrown-child'

/** A turn, prompt, held send or owed wake-up ends with a write in the chat itself, so each drain
 *  reads that work again; child work and a Dispatch end on an edge, and a two-minute check
 *  catches a missed one. */
const SETTLES_IN_CHAT = new Set(['turn', 'prompt', 'held-send', 'wake-up'])
const HOLD_CHECK_MS = 2 * 60_000

type Hold = {
  transition: StructuredAgentSessionAccountTransition
  fence: number
  /** `work`: read owed work again; `account`: read everything again. */
  stale: 'none' | 'work' | 'account'
  timer: ReturnType<typeof setTimeout>
}

/** Chats whose person-sent work waits for an account move: the move read once, kept until an
 *  edge that can end it, so drains in between read nothing. */
export class AccountMoveHolds {
  private readonly held = new Map<string, Hold>()
  /** Reads run outside the chat's lane; only the newest may set or clear its hold. */
  private readonly reading = new Map<string, number>()
  private reads = 0
  private unsubscribe: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly wake: (sessionId: string) => void,
    private readonly wakes: () => StructuredAgentSessionHostDeps['accountMoveWakes'],
    private readonly now: () => number,
    private readonly sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  ) {}

  /** The kept move for this child; `fresh` when no edge has touched it since. */
  reusable(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string
  ): { transition: StructuredAgentSessionAccountTransition; fresh: boolean } | undefined {
    const hold = this.held.get(sessionId)
    if (!hold || hold.stale === 'account' || session?.child?.fence !== hold.fence) {
      return undefined
    }
    return {
      transition: hold.transition,
      fresh: hold.stale === 'none' && !SETTLES_IN_CHAT.has(hold.transition.waitsFor)
    }
  }

  begin(sessionId: string): number {
    const read = ++this.reads
    this.reading.set(sessionId, read)
    return read
  }

  /** Whether `read` is still the newest; a newer read or a settled hold has overtaken it otherwise. */
  end(sessionId: string, read: number): boolean {
    const newest = this.reading.get(sessionId) === read
    if (newest) {
      this.reading.delete(sessionId)
    }
    return newest
  }

  stale(sessionId: string, level: 'work' | 'account'): void {
    const hold = this.held.get(sessionId)
    if (hold && hold.stale !== 'account') {
      hold.stale = level
    }
  }

  observe(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string,
    transition: StructuredAgentSessionAccountTransition | null
  ): void {
    this.reading.delete(sessionId)
    if (this.disposed) {
      return
    }
    const wasHeld = this.held.has(sessionId)
    if (!transition || !session?.child) {
      if (session) {
        delete session.awaitsAccountMove
      }
      this.release(sessionId)
      if (wasHeld && session) {
        // Republish so the queue stops naming the held card's wait.
        this.wake(sessionId)
      }
      return
    }
    this.clearTimer(sessionId)
    session.awaitsAccountMove = true
    const until = transition.wakeUpUntil ?? this.now() + HOLD_CHECK_MS
    const timer = setTimeout(
      () => {
        this.stale(sessionId, 'work')
        this.wakeOrRelease(sessionId)
      },
      Math.max(0, until - this.now()) + 1
    )
    timer.unref?.()
    this.held.set(sessionId, { transition, fence: session.child.fence, stale: 'none', timer })
    this.unsubscribe ??= this.wakes()?.subscribe((edge) => this.edge(edge))
    if (!wasHeld) {
      this.wake(sessionId)
    }
  }

  /** A Dispatch change can end only a hold that waits on one; a selection change ends any. */
  private edge(edge: StructuredAgentSessionAccountMoveEdge): void {
    for (const [id, hold] of this.held) {
      if (edge === 'account') {
        this.stale(id, 'account')
      } else if (hold.transition.waitsFor === 'dispatch') {
        this.stale(id, 'work')
      } else {
        continue
      }
      this.wakeOrRelease(id)
    }
  }

  /** A chat closed while held has nothing left to send. */
  private wakeOrRelease(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.wake(sessionId)
    } else {
      this.release(sessionId)
    }
  }

  private release(sessionId: string): void {
    this.clearTimer(sessionId)
    this.held.delete(sessionId)
    this.reading.delete(sessionId)
    if (this.held.size === 0) {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  private clearTimer(sessionId: string): void {
    const hold = this.held.get(sessionId)
    if (hold) {
      clearTimeout(hold.timer)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.held.keys()) {
      this.clearTimer(id)
    }
    this.held.clear()
    this.reading.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}
