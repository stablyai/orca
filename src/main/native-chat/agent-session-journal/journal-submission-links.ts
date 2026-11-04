import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalInputSourceFamily, journalInputSourceSequence } from './journal-input-source'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Reverse links derive from submission rows and share the reducer lifetime. */
export class JournalSubmissionLinks {
  private readonly linked = new Map<string, Map<string, AgentJournalSubmission>>()
  private readonly ids = new Map<string, { family: string; sequence: number }>()
  private readonly latest = new Map<string, string>()
  private revision = 0
  /** Where the latest provider-accepted input was actually handed over; the admission cursor the queue
   *  pauses by can predate it. Derived with the links, so a restore rebuilds it. */
  private acceptedHandoverAt = 0

  version(): number {
    return this.revision
  }
  acceptedHandover(): number {
    return this.acceptedHandoverAt
  }
  to(id: string): Iterable<AgentJournalSubmission> {
    return this.linked.get(id)?.values() ?? []
  }
  original(family: string): AgentJournalSubmission | undefined {
    const id = this.latest.get(family)
    return id ? this.linked.get(family)?.get(id) : undefined
  }
  refreshInput(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    if (entry?.dispatchState === 'accepted') {
      const handedOverAt = state.items.get(agentJournalSubmissionKey(id))?.sequence ?? 0
      this.acceptedHandoverAt = Math.max(this.acceptedHandoverAt, handedOverAt)
    }
    const source = state.inputs.sources.get(id)
    this.refresh(
      id,
      state.submissions.get(id),
      journalInputSourceFamily(source),
      journalInputSourceSequence(source)
    )
  }
  refresh(
    id: string,
    entry: AgentJournalSubmission | undefined,
    family?: string,
    sequence = 0
  ): void {
    const priorLink = this.ids.get(id)?.family
    const link = entry && (entry.queuedMessageId ?? family)
    if (priorLink !== link && priorLink) {
      const prior = this.linked.get(priorLink)!
      prior.delete(id)
      if (prior.size === 0) {
        this.linked.delete(priorLink)
      }
      this.ids.delete(id)
      if (this.latest.get(priorLink) === id) {
        this.latest.delete(priorLink)
        let newest = -Infinity
        for (const member of prior.keys()) {
          const at = this.ids.get(member)?.sequence ?? 0
          if (at >= newest) {
            newest = at
            this.latest.set(priorLink, member)
          }
        }
      }
      this.revision++
    }
    if (link && entry) {
      const entries = this.linked.get(link) ?? new Map<string, AgentJournalSubmission>()
      if (entries.get(id) !== entry) {
        entries.set(id, entry)
        this.linked.set(link, entries)
        this.ids.set(id, { family: link, sequence })
      }
      this.ids.set(id, { family: link, sequence })
      const latest = this.latest.get(link)
      if (!latest || sequence >= (this.ids.get(latest)?.sequence ?? 0)) {
        this.latest.set(link, id)
      }
      this.revision++
    }
  }
}
