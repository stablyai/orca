// The order of what a conversation's record learns about its child's options.
//
// A pick and a child's report both write the record's options, but a report describes the child as
// of its read, which can predate a pick still in flight, a saved value the child showed it cannot
// run, or a newer report. A pick or such a value moves the revision; a report carries the revision
// it was read at and is admitted only if nothing moved it since. Reports are ordered among
// themselves by arrival, so a read's stamp never depends on when an earlier report was taken, and
// the newest admitted report is the only one persisted.

export class StructuredAgentSessionOptionRevisions {
  private readonly revisions = new Map<string, number>()
  private readonly newestReports = new Map<string, number>()
  private reports = 0

  current(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0
  }

  /** What any report read before now says is out of date. */
  advance(sessionId: string): number {
    const next = this.current(sessionId) + 1
    this.revisions.set(sessionId, next)
    return next
  }

  /** A report read at `readAt` becomes the newest word, or null when a pick came since its read. */
  admitReport(sessionId: string, readAt: number): number | null {
    if (readAt !== this.current(sessionId)) {
      return null
    }
    const admitted = ++this.reports
    this.newestReports.set(sessionId, admitted)
    return admitted
  }

  /** Whether the report admitted as `admitted`, read at `readAt`, is still the newest word. */
  isNewest(sessionId: string, readAt: number, admitted: number): boolean {
    return readAt === this.current(sessionId) && this.newestReports.get(sessionId) === admitted
  }

  /** The conversation closed with no child: nothing it reported is still to be persisted. */
  forget(sessionId: string): void {
    this.revisions.delete(sessionId)
    this.newestReports.delete(sessionId)
  }
}
