// Sends that arrive while the provider is already inside a turn.
//
// The host serializes mutations only until each adapter call RETURNS, which is
// long before the turn that call started reaches its terminal journal event. A
// second send inside that window is coalesced by the provider into the turn
// already running: the journal then records two ordered turns the provider only
// ever ran as one. Refusing the second send would take send-and-forget away
// from behaviour people already rely on, so the submission is still appended
// durably and only its DISPATCH waits.
//
// The queue is not a list this class owns — it is the set of submissions the
// journal marks `queued`, in journal order. That is what lets a host which
// restarts mid-wait pick the held sends up again instead of stranding them as
// delivery unconfirmed.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type QueuedStructuredAgentSessionSend = {
  clientMessageId: string
  body: AgentJournalMessageItem
}

/** The journal's own answer to "is a turn running right now". */
export function structuredAgentSessionTurnIsActive(
  journal: AgentSessionJournal | undefined
): boolean {
  return journal ? activeStructuredAgentSessionTurnId(journal.snapshot().items) !== null : false
}

/** The sends this journal is holding back, oldest first. The body comes from the
 *  submission's own render item, which no provider echo can have revised: a
 *  queued send was never dispatched, so nothing echoed it. */
export function queuedStructuredAgentSessionSends(
  journal: AgentSessionJournal
): QueuedStructuredAgentSessionSend[] {
  const queued = journal.submissions().filter((entry) => entry.queued === true)
  if (queued.length === 0) {
    return []
  }
  const bodies = new Map(journal.snapshot().items.map((item) => [item.itemId, item.body]))
  return queued.flatMap((entry) => {
    const body = bodies.get(agentJournalSubmissionKey(entry.clientMessageId))
    return body?.kind === 'message' ? [{ clientMessageId: entry.clientMessageId, body }] : []
  })
}

export type StructuredAgentSessionSendQueueDeps = {
  journalFor: (sessionId: string) => AgentSessionJournal | undefined
  /** Dispatches one held send on the session's serialized lane. True when the
   *  provider took it, so a turn is expected to follow. */
  release: (sessionId: string, send: QueuedStructuredAgentSessionSend) => Promise<boolean>
  onError?: (input: { sessionId: string; error: unknown }) => void
}

export class StructuredAgentSessionSendQueue {
  /** Last turn state observed per journal. A journal this host has not seen —
   *  the one a fresh attach opens — has no entry, which is what makes a restart
   *  release its held sends without waiting for an edge that already passed. */
  private readonly observedTurnActive = new WeakMap<AgentSessionJournal, boolean>()
  private readonly releasing = new Set<string>()

  constructor(private readonly deps: StructuredAgentSessionSendQueueDeps) {}

  /** Whether this send's dispatch must wait. A running turn holds it, and so
   *  does an older held send — releasing out of order would put the provider's
   *  dispatch order at odds with the journal's. */
  defersSend(sessionId: string): boolean {
    const journal = this.deps.journalFor(sessionId)
    if (structuredAgentSessionTurnIsActive(journal)) {
      // Recorded here and not only on publish: the falling edge that releases
      // this send has to be measured against a turn this host saw running.
      if (journal) {
        this.observedTurnActive.set(journal, true)
      }
      return true
    }
    return (
      this.releasing.has(sessionId) ||
      (journal !== undefined && queuedStructuredAgentSessionSends(journal).length > 0)
    )
  }

  /** One journal publication. At most ONE held send is released per turn that
   *  ends, so a released send never reaches the provider inside the turn the
   *  send before it just started. */
  observe(sessionId: string): void {
    const journal = this.deps.journalFor(sessionId)
    if (!journal) {
      return
    }
    const active = structuredAgentSessionTurnIsActive(journal)
    const observed = this.observedTurnActive.get(journal)
    this.observedTurnActive.set(journal, active)
    if (active || observed === false) {
      return
    }
    this.releaseNext(sessionId)
  }

  private releaseNext(sessionId: string): void {
    if (this.releasing.has(sessionId)) {
      return
    }
    const journal = this.deps.journalFor(sessionId)
    const next = journal ? queuedStructuredAgentSessionSends(journal)[0] : undefined
    if (!next) {
      return
    }
    this.releasing.add(sessionId)
    void this.deps
      .release(sessionId, next)
      .catch((error: unknown) => {
        this.deps.onError?.({ sessionId, error })
        return false
      })
      .then((turnExpected) => {
        this.releasing.delete(sessionId)
        // No turn will ever end for a send the provider did not take, so one
        // that failed must not strand the sends waiting behind it.
        if (!turnExpected && !structuredAgentSessionTurnIsActive(this.deps.journalFor(sessionId))) {
          this.releaseNext(sessionId)
        }
      })
  }
}
