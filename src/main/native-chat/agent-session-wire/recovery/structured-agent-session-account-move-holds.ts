// Chats whose sends wait for an account move, and the edges that may end the wait.

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

/** Who waits on a hold: the person's queued cards, or a usage-limit continue that is due. */
export type AccountMoveReader = 'person' | 'sweep'

type Hold = {
  transition: StructuredAgentSessionAccountTransition
  fence: number
  /** `work`: read owed work again; `account`: read everything again. */
  stale: 'none' | 'work' | 'account'
  timer: ReturnType<typeof setTimeout>
  readers: Set<AccountMoveReader>
}

/** Chats whose sends wait for an account move: the move read once, kept until an edge that can
 *  end it, so drains and sweeps in between read nothing. */
export class AccountMoveHolds {
  private readonly held = new Map<string, Hold>()
  /** Held chats a Dispatch change can release, so one walks only these. */
  private readonly onDispatch = new Set<string>()
  /** Reads run outside the chat's lane; only the newest may set or clear its hold. */
  private readonly reading = new Map<string, number>()
  /** Children whose next start stays on their account, as of a selection; per live session. */
  private readonly noMove = new WeakMap<
    StructuredAgentSessionHostSession,
    { fence: number; selection: number; values: readonly unknown[] }
  >()
  /** Bumped by every account selection change: a cached "no move" from before it is void. */
  private selection = 0
  private reads = 0
  private unsubscribe: (() => void) | undefined
  private dispatchWalk: ReturnType<typeof setImmediate> | undefined
  private disposed = false

  constructor(
    private readonly deps: {
      wake: (sessionId: string) => void
      wakes: () => StructuredAgentSessionHostDeps['accountMoveWakes']
      /** Which of these chats' own Dispatches are still open, read together. */
      dispatchesOpen: (sessionIds: readonly string[]) => ReadonlySet<string>
      now: () => number
      sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
    }
  ) {}

  /** An untouched hold the person's cards wait on: nothing they hold can be sent yet. */
  heldForPerson(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string
  ): boolean {
    return (
      this.reusable(session, sessionId)?.fresh === true &&
      this.held.get(sessionId)?.readers.has('person') === true
    )
  }

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

  /** The child's next start was read to stay on its account, and no selection changed since. */
  staysOnAccount(session: StructuredAgentSessionHostSession | undefined): boolean {
    const known = session && this.noMove.get(session)
    const values = this.deps.wakes()?.selection?.()
    return (
      !!known &&
      !!values &&
      known.fence === session.child?.fence &&
      known.selection === this.selection &&
      known.values.length === values.length &&
      known.values.every((value, index) => Object.is(value, values[index]))
    )
  }

  staysOnAccountFrom(session: StructuredAgentSessionHostSession | undefined): void {
    const values = this.deps.wakes()?.selection?.()
    if (session?.child && values && !this.disposed) {
      this.subscribe()
      this.noMove.set(session, { fence: session.child.fence, selection: this.selection, values })
    }
  }

  begin(sessionId: string): number {
    const read = ++this.reads
    this.reading.set(sessionId, read)
    return read
  }

  /** Whether `read` is still the newest; a newer read or an edge has overtaken it otherwise. */
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
    // A read begun before this edge may not install what it saw; the edge's own pass reads again.
    this.reading.delete(sessionId)
  }

  /** `reader` now waits on the kept move (it was fresh, so nothing was read). */
  adopt(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string,
    reader: AccountMoveReader
  ): void {
    const hold = this.held.get(sessionId)
    if (hold && session && !hold.readers.has(reader)) {
      hold.readers.add(reader)
      this.publishPerson(session, sessionId, hold)
    }
  }

  observe(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string,
    transition: StructuredAgentSessionAccountTransition | null,
    reader: AccountMoveReader
  ): void {
    this.reading.delete(sessionId)
    if (this.disposed) {
      return
    }
    const previous = this.held.get(sessionId)
    if (!transition || !session?.child) {
      this.release(session, sessionId)
      return
    }
    if (previous) {
      clearTimeout(previous.timer)
    }
    const until = transition.wakeUpUntil ?? this.deps.now() + HOLD_CHECK_MS
    const timer = setTimeout(
      () => {
        this.stale(sessionId, 'work')
        this.wakeOrRelease(sessionId)
      },
      Math.max(0, until - this.deps.now()) + 1
    )
    timer.unref?.()
    const readers = previous?.readers ?? new Set<AccountMoveReader>()
    readers.add(reader)
    const hold: Hold = { transition, fence: session.child.fence, stale: 'none', timer, readers }
    this.held.set(sessionId, hold)
    if (transition.waitsFor === 'dispatch') {
      this.onDispatch.add(sessionId)
    } else {
      this.onDispatch.delete(sessionId)
    }
    this.subscribe()
    this.publishPerson(session, sessionId, hold)
  }

  /** `reader` no longer waits; the hold goes once nobody does. */
  forget(
    session: StructuredAgentSessionHostSession | undefined,
    sessionId: string,
    reader: AccountMoveReader
  ): void {
    const hold = this.held.get(sessionId)
    if (!hold) {
      return
    }
    hold.readers.delete(reader)
    if (hold.readers.size === 0) {
      this.release(session, sessionId)
    } else if (reader === 'person' && session?.awaitsAccountMove) {
      delete session.awaitsAccountMove
      this.deps.wake(sessionId)
    }
  }

  /** Only a hold the person's cards wait on changes what the queue shows. */
  private publishPerson(
    session: StructuredAgentSessionHostSession,
    sessionId: string,
    hold: Hold
  ): void {
    if (hold.readers.has('person') && !session.awaitsAccountMove) {
      session.awaitsAccountMove = true
      // Republish so the queue stops naming the held card as next.
      this.deps.wake(sessionId)
    }
  }

  private subscribe(): void {
    // Stays on: each event costs O(1) with nothing held, and the selection epoch must not miss one.
    this.unsubscribe ??= this.deps.wakes()?.subscribe((edge) => this.edge(edge))
  }

  /** A Dispatch change ends only a hold whose own Dispatch closed; a selection change ends any. */
  private edge(edge: StructuredAgentSessionAccountMoveEdge): void {
    if (edge === 'account') {
      this.selection++
      this.walk(edge)
    } else if (this.onDispatch.size > 0) {
      // Events name no Dispatch: held chats' own are read in one query, once per burst.
      this.dispatchWalk ??= setImmediate(() => {
        this.dispatchWalk = undefined
        this.walk('dispatch')
      })
    }
  }

  private walk(edge: StructuredAgentSessionAccountMoveEdge): void {
    // A copy: waking can release, which edits what is walked.
    const ids = Array.from(edge === 'account' ? this.held.keys() : this.onDispatch)
    const open =
      edge === 'dispatch'
        ? this.deps.dispatchesOpen(ids.filter((id) => this.deps.sessions.has(id)))
        : undefined
    for (const id of ids) {
      if (open?.has(id) && this.deps.sessions.has(id)) {
        continue
      }
      this.stale(id, edge === 'account' ? 'account' : 'work')
      this.wakeOrRelease(id)
    }
  }

  /** A chat closed while held has nothing left to send. */
  private wakeOrRelease(sessionId: string): void {
    if (this.deps.sessions.has(sessionId)) {
      this.deps.wake(sessionId)
    } else {
      this.release(undefined, sessionId)
    }
  }

  private release(session: StructuredAgentSessionHostSession | undefined, sessionId: string): void {
    const hold = this.held.get(sessionId)
    if (hold) {
      clearTimeout(hold.timer)
    }
    this.held.delete(sessionId)
    this.onDispatch.delete(sessionId)
    this.reading.delete(sessionId)
    if (session?.awaitsAccountMove) {
      delete session.awaitsAccountMove
      // Republish so the queue stops naming the held card's wait.
      this.deps.wake(sessionId)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const hold of this.held.values()) {
      clearTimeout(hold.timer)
    }
    this.held.clear()
    this.onDispatch.clear()
    this.reading.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.dispatchWalk) {
      clearImmediate(this.dispatchWalk)
      this.dispatchWalk = undefined
    }
  }
}
