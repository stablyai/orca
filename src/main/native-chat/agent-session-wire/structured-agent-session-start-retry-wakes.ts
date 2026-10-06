// The delivery loop's one booked wake per session, for the next message waiting out a refused start.
// A cache: every step re-derives what is due from the journal, and a quit cancels them all.

import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  nextStartRetryAt,
  setStartRetryTimer
} from './structured-agent-session-start-attempt-failure'

export class StructuredAgentSessionStartRetryWakes {
  private readonly timers = new Map<string, () => void>()

  constructor(
    private readonly deps: {
      now: () => number
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      logger: StructuredAgentSessionLogger
      setTimer?: (delayMs: number, run: () => void) => () => void
    },
    private readonly wake: (sessionId: string) => void
  ) {}

  /** Replaces the session's wake with one for the next try due after `decidedAt`, if any. */
  rebook(
    sessionId: string,
    journal: Parameters<typeof nextStartRetryAt>[0],
    decidedAt: number
  ): void {
    this.timers.get(sessionId)?.()
    this.timers.delete(sessionId)
    const due = nextStartRetryAt(journal, decidedAt)
    if (due === null) {
      return
    }
    const setTimer = this.deps.setTimer ?? setStartRetryTimer
    const cancel = setTimer(Math.max(0, due - this.deps.now()), () => {
      this.timers.delete(sessionId)
      void this.deps
        .serialize(sessionId, async () => this.wake(sessionId))
        .catch((error: unknown) =>
          this.deps.logger.warn('retrying a failed start failed', {
            scope: 'delivery-loop-retry',
            sessionId,
            error
          })
        )
    })
    this.timers.set(sessionId, cancel)
  }

  dispose(): void {
    for (const cancel of this.timers.values()) {
      cancel()
    }
    this.timers.clear()
  }
}
