import type { JournalSubmissionLinkFacts } from '../journal-input-facts-storage'
import type { JournalInputIndexStorage } from '../journal-index-storage'
import { memoryJournalInputIndexStorage } from '../journal-memory-input-index-storage'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalInputSourceFamily, journalInputSourceSequence } from './journal-input-source'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** Reverse links derive from submission rows and share the reducer lifetime. */
export class JournalSubmissionLinks {
  private readonly facts: JournalSubmissionLinkFacts
  constructor(private readonly indexes: JournalInputIndexStorage = memoryJournalInputIndexStorage) {
    this.facts = indexes.linkFacts()
  }

  version(): number {
    return this.facts.revision
  }
  acceptedHandover(): number {
    return this.facts.acceptedHandoverAt
  }
  to(id: string): Iterable<AgentJournalSubmission> {
    return this.facts.familyMembers(id)
  }
  original(family: string): AgentJournalSubmission | undefined {
    const id = this.facts.latest.get(family)
    return id ? this.facts.linked.get(family)?.get(id) : undefined
  }
  refreshInput(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    if (entry?.dispatchState === 'accepted') {
      const handedOverAt = state.items.get(agentJournalSubmissionKey(id))?.sequence ?? 0
      this.facts.acceptedHandoverAt = Math.max(this.facts.acceptedHandoverAt, handedOverAt)
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
    const priorLink = this.facts.ids.get(id)?.family
    const link = entry && (entry.queuedMessageId ?? family)
    if (priorLink !== link && priorLink) {
      const prior = this.facts.linked.get(priorLink)!
      prior.delete(id)
      if (prior.size === 0) {
        this.facts.linked.delete(priorLink)
      }
      this.facts.ids.delete(id)
      if (this.facts.latest.get(priorLink) === id) {
        this.facts.latest.delete(priorLink)
        let newest = -Infinity
        for (const member of this.facts.familyMemberIds(priorLink)) {
          const at = this.facts.ids.get(member)?.sequence ?? 0
          if (at >= newest) {
            newest = at
            this.facts.latest.set(priorLink, member)
          }
        }
      }
      this.facts.revision++
    }
    if (link && entry) {
      const entries =
        this.facts.linked.get(link) ??
        this.indexes.map<string, AgentJournalSubmission>('link-family', link)
      if (entries.get(id) !== entry) {
        entries.set(id, entry)
        this.facts.linked.set(link, entries)
        this.facts.ids.set(id, { family: link, sequence })
      }
      this.facts.ids.set(id, { family: link, sequence })
      const latest = this.facts.latest.get(link)
      if (!latest || sequence >= (this.facts.ids.get(latest)?.sequence ?? 0)) {
        this.facts.latest.set(link, id)
      }
      this.facts.revision++
    }
  }
}
