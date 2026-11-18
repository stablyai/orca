/** Chats with a send in flight, counted per chat; the first hold lifts writes already queued as bulk. */
export class JournalSqlSendingChats {
  private readonly held = new Map<string, number>()

  constructor(private readonly promote: (sessionId: string) => void) {}

  hold(sessionId: string): () => void {
    const count = this.held.get(sessionId) ?? 0
    this.held.set(sessionId, count + 1)
    if (count === 0) {
      this.promote(sessionId)
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.held.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        this.held.set(sessionId, remaining)
      } else {
        this.held.delete(sessionId)
      }
    }
  }

  has(sessionId: string): boolean {
    return this.held.has(sessionId)
  }
}
