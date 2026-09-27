import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

/**
 * The host's open conversations. A journal handle becomes a conversation's when it is set here,
 * and from then on every change it commits reaches that conversation's readers: no writer
 * publishes what it appended, so none can forget to.
 *
 * Delivery runs a microtask after the commit, so a reader that throws cannot fail a write that is
 * already durable. A handle this map has since replaced or dropped delivers nothing.
 */
export class StructuredAgentSessionConversations extends Map<
  string,
  StructuredAgentSessionHostSession
> {
  constructor(
    private readonly delivery: {
      deliver: (sessionId: string, journal: AgentSessionJournal) => void
      onDeliveryError: (sessionId: string, error: unknown) => void
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
    return super.set(sessionId, session)
  }
}
