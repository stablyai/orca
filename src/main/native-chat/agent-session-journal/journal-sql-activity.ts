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
