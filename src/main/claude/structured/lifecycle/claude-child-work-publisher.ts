// Child-work evidence reaches the host after the frame's journal rows, and a held wake expires with
// no frame at all, so the row is restated on a timer once its lease runs out.

import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../claude-structured-session-state'
import { drainClaudeChildWork } from '../../child-work/claude-child-work-evidence'
import { ClaudeChildWakeExpiryTimers } from './claude-child-wake-expiry-timers'

type PublisherDeps = Pick<ClaudeStructuredSessionAdapterDeps, 'now' | 'onChildWorkEvidence'>

/** Publish child records after the frame's journal rows and parent record. */
export class ClaudeChildWorkPublisher {
  private readonly timers: ClaudeChildWakeExpiryTimers

  constructor(
    private readonly deps: PublisherDeps,
    private readonly session: (sessionId: string) => ClaudeSession | undefined
  ) {
    this.timers = new ClaudeChildWakeExpiryTimers((sessionId) => this.publish(sessionId))
  }

  publish(
    sessionId: string,
    session: ClaudeSession | null | undefined = this.session(sessionId),
    message: Record<string, unknown> | null = null
  ): void {
    const evidence = drainClaudeChildWork(session, message, this.deps.now?.() ?? Date.now())
    if (evidence.length > 0) {
      this.deps.onChildWorkEvidence?.(sessionId, evidence, session?.events)
    }
    if (session) {
      this.restateDueWokenRow(sessionId, session)
    }
  }

  close(sessionId: string): void {
    this.timers.clear(sessionId)
  }

  closeAll(): void {
    this.timers.clearAll()
  }

  private restateDueWokenRow(sessionId: string, session: ClaudeSession): void {
    const expiry = session.childWork.wakeExpiryAt()
    const due = this.timers.arm(sessionId, expiry, performance.now())
    if (due) {
      this.publish(sessionId, session)
    }
  }
}
