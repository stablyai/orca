import { codexFrameThreadId, codexTurnId } from './codex-shared-server-frames'

const MAX_RECENT_COMPLETED_TURNS = 1_024

/** Every turn running on one server, seen before any chat's queue so backpressure can't hide it,
 *  plus turn/starts still in flight, so Stop can prove each of a chat's turns ended. */
export class CodexSharedServerTurns {
  private readonly running = new Map<string, string>()
  private readonly recentlyCompleted = new Set<string>()
  /** Re-checked on every change; each leaves at its deadline, so retries on a turn that never
   *  ends hold nothing. */
  private readonly waiters = new Set<() => void>()
  private readonly pendingStarts = new Map<string, Set<Promise<unknown>>>()

  trackStart(threadId: string, request: Promise<unknown>): void {
    const pending = this.pendingStarts.get(threadId) ?? new Set()
    pending.add(request)
    this.pendingStarts.set(threadId, pending)
    const settle = (): void => {
      pending.delete(request)
      if (pending.size === 0 && this.pendingStarts.get(threadId) === pending) {
        this.pendingStarts.delete(threadId)
      }
      this.changed()
    }
    request.then(settle, settle)
  }

  noteStarted(threadId: string, turnId: string): void {
    if (!this.recentlyCompleted.has(turnId)) {
      this.running.set(threadId, turnId)
    }
  }

  observe(method: string, params: unknown): void {
    const threadId = codexFrameThreadId(params)
    const turnId = codexTurnId(params)
    if (!threadId || !turnId) {
      return
    }
    if (method === 'turn/started') {
      this.noteStarted(threadId, turnId)
    } else if (method === 'turn/completed') {
      this.complete(threadId, turnId)
    }
  }

  runningOn(threadId: string): string | undefined {
    return this.running.get(threadId)
  }

  anyStartPending(threads: readonly string[]): boolean {
    return threads.some((threadId) => this.pendingStarts.has(threadId))
  }

  /** true once `done()` holds, false at the deadline (none when null); re-checked whenever a turn,
   *  start or open ends, or a chat leaves. */
  waitUntil(done: () => boolean, ms: number | null): Promise<boolean> {
    if (done()) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(value)
      }
      const check = (): void => {
        if (done()) {
          finish(true)
        }
      }
      const timer = ms === null ? undefined : setTimeout(() => finish(done()), ms)
      this.waiters.add(check)
    })
  }

  changed(): void {
    for (const check of this.waiters) {
      check()
    }
  }

  /** The process is gone, so every turn it ran is over. */
  endAll(): void {
    this.running.clear()
    this.pendingStarts.clear()
    this.changed()
  }

  private complete(threadId: string, turnId: string): void {
    if (this.running.get(threadId) === turnId) {
      this.running.delete(threadId)
    }
    this.recentlyCompleted.add(turnId)
    if (this.recentlyCompleted.size > MAX_RECENT_COMPLETED_TURNS) {
      const oldest = this.recentlyCompleted.values().next()
      if (!oldest.done) {
        this.recentlyCompleted.delete(oldest.value)
      }
    }
    this.changed()
  }
}
