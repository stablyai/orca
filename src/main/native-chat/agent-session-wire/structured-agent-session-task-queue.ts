import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'

/** Clear of the longest legitimate in-chain wait, a compaction bounded at 180s
 *  (`structured-session-compaction.ts`). */
export const STRUCTURED_AGENT_SESSION_TASK_STALL_MS = 240_000

export type StructuredAgentSessionTaskStall = { sessionId: string; ageMs: number }

type RunningTask = { startedAt: number; deadline: NodeJS.Timeout; stalled: boolean }

/**
 * Serializes mutations per session. A task that never settles parks every later mutation for that
 * session, so the queue reports one that outlives its stall threshold.
 *
 * It reports; it never cancels. Timing a task out of the chain would not cancel the host work it is
 * waiting on -- it would only let a later mutation run out of order against a session whose earlier
 * mutation is still live.
 */
export class StructuredAgentSessionTaskQueue {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly attaching = new Set<Promise<unknown>>()
  private readonly running = new Map<string, RunningTask>()

  constructor(
    private readonly options: {
      stallMs?: number
      onStalled?: (stall: StructuredAgentSessionTaskStall) => void
      now?: () => number
    } = {}
  ) {}

  serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    return runKeyedSerializedOperation(this.chains, sessionId, () => this.watch(sessionId, task))
  }

  /** Sessions whose running task has been reported stalled, with its current age. */
  stalledTasks(): StructuredAgentSessionTaskStall[] {
    const now = this.now()
    return [...this.running]
      .filter(([, task]) => task.stalled)
      .map(([sessionId, task]) => ({ sessionId, ageMs: now - task.startedAt }))
  }

  trackAttach<T>(operation: Promise<T>): Promise<T> {
    this.attaching.add(operation)
    void operation.then(
      () => this.attaching.delete(operation),
      () => this.attaching.delete(operation)
    )
    return operation
  }

  async drainAttaches(): Promise<void> {
    while (this.attaching.size > 0) {
      await Promise.allSettled(this.attaching)
    }
  }

  private async watch<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const stallMs = this.options.stallMs ?? STRUCTURED_AGENT_SESSION_TASK_STALL_MS
    const running: RunningTask = {
      startedAt: this.now(),
      deadline: setTimeout(() => this.report(sessionId), stallMs),
      stalled: false
    }
    // Why: a report is diagnostics; it must never be the reason a process stays alive.
    if (typeof running.deadline.unref === 'function') {
      running.deadline.unref()
    }
    this.running.set(sessionId, running)
    try {
      return await task()
    } finally {
      clearTimeout(running.deadline)
      if (this.running.get(sessionId) === running) {
        this.running.delete(sessionId)
      }
    }
  }

  private report(sessionId: string): void {
    const running = this.running.get(sessionId)
    if (!running) {
      return
    }
    running.stalled = true
    this.options.onStalled?.({ sessionId, ageMs: this.now() - running.startedAt })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
