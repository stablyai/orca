// A held child-work wake expires with no frame at all, so the row has to be restated on a timer.

import { CodexSubagentPollScheduler } from '../../../../shared/agent-hook-listener/transcripts/codex-subagent-poll-scheduler'

/** Restates a session's row once its child-work wake lease runs out. */
export class ClaudeChildWakeExpiryTimers {
  private readonly timers = new CodexSubagentPollScheduler<void>(0, (sessionId) => {
    this.armed.delete(sessionId)
    this.restate(sessionId)
  })
  private readonly restate: (sessionId: string) => void
  /** Each session's armed deadline, so frames that leave it unchanged skip the scheduler. */
  private readonly armed = new Map<string, number>()

  constructor(restate: (sessionId: string) => void) {
    this.restate = restate
  }

  /**
   * Aim a restate at the lease `expiry` from `nowN`, or clear it when no wake is held. An expiry that
   * already passed restates in this turn instead of waiting a zero-length timer.
   */
  arm(sessionId: string, expiry: number | undefined, nowN: number): boolean {
    if (expiry === undefined || expiry <= nowN) {
      this.clear(sessionId)
      return expiry !== undefined
    }
    if (this.armed.get(sessionId) !== expiry) {
      this.armed.set(sessionId, expiry)
      this.timers.schedule(sessionId, undefined, expiry - nowN)
    }
    return false
  }

  clear(sessionId: string): void {
    if (this.armed.delete(sessionId)) {
      this.timers.clear(sessionId)
    }
  }

  clearAll(): void {
    this.armed.clear()
    this.timers.clearAll()
  }
}
