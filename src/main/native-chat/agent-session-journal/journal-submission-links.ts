import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'

/** Reverse links derive from submission rows and share the reducer lifetime. */
export class JournalSubmissionLinks {
  private readonly linked = new Map<string, Map<string, AgentJournalSubmission>>()
  private readonly ids = new Map<string, string>()
  private revision = 0

  version(): number {
    return this.revision
  }
  to(id: string): Iterable<AgentJournalSubmission> {
    return this.linked.get(id)?.values() ?? []
  }
  refresh(id: string, entry: AgentJournalSubmission | undefined): void {
    const priorLink = this.ids.get(id)
    const link = entry?.queuedMessageId
    if (priorLink !== link && priorLink) {
      const prior = this.linked.get(priorLink)!
      prior.delete(id)
      if (prior.size === 0) {
        this.linked.delete(priorLink)
      }
      this.ids.delete(id)
      this.revision++
    }
    if (link && entry) {
      const entries = this.linked.get(link) ?? new Map<string, AgentJournalSubmission>()
      if (entries.get(id) !== entry) {
        entries.set(id, entry)
        this.linked.set(link, entries)
        this.ids.set(id, link)
      }
      this.revision++
    }
  }
}
