/** Live turns and admitted foreground work pause maintenance; opening conversion can promote itself. */
export class JournalSqlActivity {
  private readonly sessions = new Set<string>()
  private foreground = 0
  private readonly idle = new Set<() => void>()

  setSessionActive(sessionId: string, active: boolean): void {
    if (active) {
      this.sessions.add(sessionId)
    } else {
      this.sessions.delete(sessionId)
      this.notifyIdle()
    }
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  hold(): () => void {
    this.foreground++
    let held = true
    return () => {
      if (held) {
        held = false
        this.foreground--
        this.notifyIdle()
      }
    }
  }

  waitForIdle = (promotion: AbortSignal): Promise<void> => {
    if (promotion.aborted || !this.active) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const ready = () => {
        this.idle.delete(ready)
        promotion.removeEventListener('abort', ready)
        resolve()
      }
      this.idle.add(ready)
      promotion.addEventListener('abort', ready, { once: true })
    })
  }

  private get active(): boolean {
    return this.foreground > 0 || this.sessions.size > 0
  }

  private notifyIdle(): void {
    if (!this.active) {
      for (const ready of this.idle) {
        ready()
      }
    }
  }
}

/** Chats with a send in flight, counted per chat, from admission until the dispatch settles. While
 *  held, the chat's writes go ahead of bulk streaming and past WAL pressure; the first hold lifts
 *  writes already queued as bulk. */
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

  /** A fork install keeps its own FULL-durability boundary and never jumps the queue. */
  urgency(sessionId: string, forkInstall: unknown): { urgent?: true } {
    return this.held.has(sessionId) && !forkInstall ? { urgent: true } : {}
  }
}
