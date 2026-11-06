import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** Submissions in one dispatch phase, listed without walking the rest of history. */
export class JournalSubmissionIndex {
  private readonly entries = new Map<string, AgentJournalSubmission>()
  private listed: readonly AgentJournalSubmission[] | undefined

  /** Returns whether membership or the indexed entry changed. */
  keep(id: string, entry: AgentJournalSubmission | undefined, member: boolean): boolean {
    if (entry && member) {
      if (this.entries.get(id) === entry) {
        return false
      }
      this.entries.set(id, entry)
    } else if (!this.entries.delete(id)) {
      return false
    }
    this.listed = undefined
    return true
  }
  values(): Iterable<AgentJournalSubmission> {
    return this.entries.values()
  }
  list(): readonly AgentJournalSubmission[] {
    return (this.listed ??= [...this.entries.values()])
  }
}
