import { codexFrameThreadId, codexTurnId } from './codex-shared-server-frames'

const MAX_RECENT_COMPLETED_TURNS = 1_024

/** True when `promise` settles first; false at the deadline. */
export async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Every turn running on one server, seen before any chat's queue so backpressure can't hide it,
 *  plus turn/starts still in flight, so Stop can prove each of a chat's turns ended. */
export class CodexSharedServerTurns {
  private readonly running = new Map<string, string>()
  private readonly recentlyCompleted = new Set<string>()
  /** One per turn, shared by every Stop retry, so a turn that never ends holds one waiter. */
  private readonly endWaiters = new Map<string, { ended: Promise<void>; resolve: () => void }>()
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

  startsPending(threads: readonly string[]): Promise<unknown>[] {
    return threads.flatMap((threadId) => [...(this.pendingStarts.get(threadId) ?? [])])
  }

  anyStartPending(threads: readonly string[]): boolean {
    return threads.some((threadId) => this.pendingStarts.has(threadId))
  }

  ended(turnId: string): Promise<void> {
    if (![...this.running.values()].includes(turnId)) {
      return Promise.resolve()
    }
    const known = this.endWaiters.get(turnId)
    if (known) {
      return known.ended
    }
    let resolve = (): void => {}
    const ended = new Promise<void>((done) => {
      resolve = done
    })
    this.endWaiters.set(turnId, { ended, resolve })
    return ended
  }

  /** The process is gone, so every turn it ran is over. */
  endAll(): void {
    this.running.clear()
    this.pendingStarts.clear()
    for (const { resolve } of this.endWaiters.values()) {
      resolve()
    }
    this.endWaiters.clear()
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
    this.endWaiters.get(turnId)?.resolve()
    this.endWaiters.delete(turnId)
  }
}
