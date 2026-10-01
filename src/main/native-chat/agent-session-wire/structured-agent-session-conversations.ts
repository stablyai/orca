import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

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
  private readonly closeObservers = new Set<(sessionId: string) => void>()

  constructor(
    private readonly delivery: {
      deliver: (sessionId: string, journal: AgentSessionJournal) => void
      onDeliveryError: (sessionId: string, error: unknown) => void
      /** A conversation became held: state that waited on it (queued drafts) re-derives. */
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
          this.delivery.onDeliveryError(sessionId, error)
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
    const deleted = super.delete(sessionId)
    if (deleted) {
      for (const observer of this.closeObservers) {
        observer(sessionId)
      }
    }
    return deleted
  }

  /** Told when a conversation leaves the map, so state kept per conversation dies with it. */
  observeClose(observer: (sessionId: string) => void): void {
    this.closeObservers.add(observer)
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
