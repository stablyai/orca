/** Incarnations whose PTY master stopped taking input; a report can land before its spawn reply. */
export class DaemonPtyInputClosedIncarnations {
  private readonly closedBySession = new Map<string, Set<string>>()

  record(sessionId: string, incarnationId: string): void {
    const closed = this.closedBySession.get(sessionId) ?? new Set<string>()
    closed.add(incarnationId)
    this.closedBySession.set(sessionId, closed)
  }

  /** A spawn reply names the live incarnation; facts about any other one no longer apply. */
  sync(
    sessionId: string,
    result: { isNew: boolean; incarnationId?: string; inputClosed?: true }
  ): void {
    if (!result.incarnationId) {
      if (result.isNew) {
        this.closedBySession.delete(sessionId)
      }
      return
    }
    if (result.inputClosed) {
      this.record(sessionId, result.incarnationId)
    }
    if (this.closedBySession.get(sessionId)?.has(result.incarnationId)) {
      this.closedBySession.set(sessionId, new Set([result.incarnationId]))
    } else {
      this.closedBySession.delete(sessionId)
    }
  }

  isClosed(sessionId: string, currentIncarnationId: string | undefined): boolean {
    const closed = this.closedBySession.get(sessionId)
    if (!closed) {
      return false
    }
    return currentIncarnationId === undefined ? closed.size > 0 : closed.has(currentIncarnationId)
  }

  delete(sessionId: string): void {
    this.closedBySession.delete(sessionId)
  }
}
