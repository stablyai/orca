type PaneTimer = { timer: ReturnType<typeof setTimeout>; paneKey: string }

/** One pending, unref'd timer per pane; `run` gets the pane's current key, which a remint may move. */
export class PaneTimers {
  private readonly byPaneKey = new Map<string, PaneTimer>()

  /** Replaces the pane's pending timer. */
  defer(paneKey: string, delayMs: number, run: (paneKey: string) => void): void {
    this.cancel(paneKey)
    this.start(paneKey, delayMs, run)
  }

  /** Keeps a pending timer, whose `run` reads current state when it fires. */
  deferUnlessPending(paneKey: string, delayMs: number, run: (paneKey: string) => void): void {
    if (!this.byPaneKey.has(paneKey)) {
      this.start(paneKey, delayMs, run)
    }
  }

  move(fromPaneKey: string, toPaneKey: string): void {
    const entry = this.byPaneKey.get(fromPaneKey)
    if (entry === undefined || fromPaneKey === toPaneKey) {
      return
    }
    this.byPaneKey.delete(fromPaneKey)
    this.cancel(toPaneKey)
    entry.paneKey = toPaneKey
    this.byPaneKey.set(toPaneKey, entry)
  }

  cancel(paneKey: string): void {
    const entry = this.byPaneKey.get(paneKey)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      this.byPaneKey.delete(paneKey)
    }
  }

  clear(): void {
    for (const entry of this.byPaneKey.values()) {
      clearTimeout(entry.timer)
    }
    this.byPaneKey.clear()
  }

  private start(paneKey: string, delayMs: number, run: (paneKey: string) => void): void {
    const entry: PaneTimer = {
      paneKey,
      timer: setTimeout(
        () => {
          this.byPaneKey.delete(entry.paneKey)
          run(entry.paneKey)
        },
        Math.max(0, delayMs)
      )
    }
    entry.timer.unref?.()
    this.byPaneKey.set(paneKey, entry)
  }
}
