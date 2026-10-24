import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Bind commit delivery at adoption so writers cannot forget publication. Deliver in a microtask
 * to isolate durable writes from reader failures; ignore replaced/dropped handles. Activity clocks are memory-only. */
export class StructuredAgentSessionConversations extends Map<
  string,
  StructuredAgentSessionHostSession
> {
  private readonly activity = new Map<string, number>()

  constructor(
    private readonly delivery: {
      deliver: (sessionId: string, journal: AgentSessionJournal) => void
      /** Settle edges write no row and renew no activity clock. */
      deliverSettleEdge?: (sessionId: string, journal: AgentSessionJournal) => void
      logger: StructuredAgentSessionLogger
      /** Opening makes waiting state re-derive. */
      onOpened?: (sessionId: string) => void
      now: () => number
    }
  ) {
    super()
  }

  override set(sessionId: string, session: StructuredAgentSessionHostSession): this {
    const { journal } = session
    let queued = false
    journal.observeCommits(() => {
      if (queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        if (this.get(sessionId)?.journal !== journal) {
          return
        }
        try {
          this.delivery.deliver(sessionId, journal)
        } catch (error) {
          this.delivery.logger.warn('delivering a journal commit failed', {
            scope: 'journal-delivery',
            sessionId,
            error
          })
        }
      })
    })
    journal.stopMarks.observeSettleEdges(() => {
      queueMicrotask(() => {
        if (this.get(sessionId)?.journal !== journal) {
          return
        }
        try {
          this.delivery.deliverSettleEdge?.(sessionId, journal)
        } catch (error) {
          this.delivery.logger.warn("delivering a Stop's settle edge failed", {
            scope: 'stop-settle-delivery',
            sessionId,
            error
          })
        }
      })
    })
    this.activity.set(sessionId, this.delivery.now())
    const adopted = super.set(sessionId, session)
    this.delivery.onOpened?.(sessionId)
    return adopted
  }

  override delete(sessionId: string): boolean {
    this.activity.delete(sessionId)
    return super.delete(sessionId)
  }

  touch(sessionId: string): void {
    if (this.has(sessionId)) {
      this.activity.set(sessionId, this.delivery.now())
    }
  }

  lastActivityAt(sessionId: string): number | undefined {
    return this.activity.get(sessionId)
  }
}
