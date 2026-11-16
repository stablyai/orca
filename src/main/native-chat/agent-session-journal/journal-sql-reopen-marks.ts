import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'

/**
 * This handle's fallback reopen boundary, held only until its queue-reopen mark commits. It is
 * not the physical opening cursor: that one never changes, while this floor is usually null.
 */
export class SqlJournalReopenMarks {
  private unmarked: AgentJournalCursor | null = null

  floor = (): AgentJournalCursor | null => this.unmarked && { ...this.unmarked }

  adopt(floor: AgentJournalCursor | null): void {
    this.unmarked = floor && { ...floor }
  }

  /**
   * As on the in-memory journal, the floor stands while the mark is written, so a failed write
   * keeps a conservative boundary and throws. A committed mark at or past it retires the floor.
   */
  async mark(
    owed: () => Promise<{ awaits: boolean; epoch: string; since: number }>,
    write: () => Promise<number | null>,
    since?: number
  ): Promise<void> {
    const answer = await owed()
    if (!answer.awaits) {
      return
    }
    const floor = { epoch: answer.epoch, sequence: since ?? answer.since }
    this.unmarked = floor
    const written = await write()
    if (this.unmarked === floor && (written === null || written >= floor.sequence)) {
      this.unmarked = null
    }
  }
}
