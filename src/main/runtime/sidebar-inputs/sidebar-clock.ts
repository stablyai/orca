/** Share one timer for sidebar settling, retention, create grace and freshness; each key holds one deadline and only the earliest arms a timeout. */
export class SidebarClock {
  private readonly deadlines = new Map<string, { at: number; fire: () => void }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private armedAt = Infinity

  /** Replaces the key's pending deadline. */
  schedule(key: string, at: number, fire: () => void): void {
    this.deadlines.set(key, { at, fire })
    this.arm()
  }

  cancel(key: string): void {
    if (this.deadlines.delete(key)) {
      this.arm()
    }
  }

  dispose(): void {
    this.deadlines.clear()
    this.arm()
  }

  private arm(): void {
    let earliest = Infinity
    for (const { at } of this.deadlines.values()) {
      earliest = Math.min(earliest, at)
    }
    if (earliest === this.armedAt) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.armedAt = earliest
    if (earliest === Infinity) {
      return
    }
    this.timer = setTimeout(() => this.fireDue(), Math.max(0, earliest - Date.now()))
    // A pending deadline must never keep a headless host from its idle exit.
    this.timer.unref?.()
  }

  private fireDue(): void {
    this.timer = null
    this.armedAt = Infinity
    const now = Date.now()
    const due = [...this.deadlines].filter(([, deadline]) => deadline.at <= now)
    due.sort(([, a], [, b]) => a.at - b.at)
    for (const [key] of due) {
      this.deadlines.delete(key)
    }
    // A fire may schedule again; arming after keeps one timer for the new earliest.
    for (const [key, deadline] of due) {
      try {
        deadline.fire()
      } catch (error) {
        console.error('[sidebar-clock] deadline failed', { key, error })
      }
    }
    this.arm()
  }
}
