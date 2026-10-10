import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/**
 * The host's open conversations. A journal handle becomes a conversation's when it is set here,
 * and from then on every change it commits reaches that conversation's readers: no writer
 * publishes what it appended, so none can forget to.
 *
 * Delivery runs a microtask after the commit, so a reader that throws cannot fail a write that is
 * already durable. A handle this map has since replaced or dropped delivers nothing.
 *
 * Each entry also carries when it last saw activity — its open, then every journal publish — which
 * is the idle sweep's clock. In memory only, so it dies with the entry.
 */
export class StructuredAgentSessionConversations extends Map<
  string,
  StructuredAgentSessionHostSession
> {
  private readonly activity = new Map<string, number>()

  constructor(
    private readonly delivery: {
      /** `lowestFence`: the lowest fence a row committed since the last delivery was written at. */
      deliver: (
        sessionId: string,
        journal: AgentSessionJournal,
        committed: { lowestFence: number | null }
      ) => void
      /** A person's Stop settle opened or closed: no row, so neither a publish nor activity. */
      deliverSettleEdge?: (sessionId: string, journal: AgentSessionJournal) => void
      logger: StructuredAgentSessionLogger
      /** A conversation became held: state that waited on it (queued drafts) re-derives. */
      onOpened?: (sessionId: string, journal: AgentSessionJournal) => void
      now: () => number
    }
  ) {
    super()
  }

  override set(sessionId: string, session: StructuredAgentSessionHostSession): this {
    const { journal } = session
    let queued = false
    let lowestFence: number | null = null
    journal.observeCommits((rows) => {
      for (const row of rows ?? []) {
        lowestFence = Math.min(lowestFence ?? row.fence, row.fence)
      }
      if (queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        const committed = { lowestFence }
        lowestFence = null
        if (this.get(sessionId)?.journal !== journal) {
          return
        }
        try {
          this.delivery.deliver(sessionId, journal, committed)
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
    this.delivery.onOpened?.(sessionId, session.journal)
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
