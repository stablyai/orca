type PaneTimer = {
  timer?: ReturnType<typeof setTimeout>
  paneKey: string
  run: (paneKey: string) => void
}

/** One unref'd timer per pane; remints move the callback to its current key. */
export class PaneTimers {
  private readonly byPaneKey = new Map<string, PaneTimer>()

  defer(paneKey: string, delayMs: number, run: (paneKey: string) => void): void {
    this.cancel(paneKey)
    this.start(paneKey, delayMs, run)
  }

  deferUnlessPending(paneKey: string, delayMs: number, run: (paneKey: string) => void): void {
    if (!this.byPaneKey.has(paneKey)) {
      this.start(paneKey, delayMs, run)
    }
  }

  park(paneKey: string, run: (paneKey: string) => void): void {
    this.cancel(paneKey)
    this.byPaneKey.set(paneKey, { paneKey, run })
  }

  wake(paneKey: string): void {
    const entry = this.byPaneKey.get(paneKey)
    if (entry && entry.timer === undefined) {
      this.start(paneKey, 0, entry.run)
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
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
      }
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
      run,
      timer: setTimeout(
        () => {
          this.byPaneKey.delete(entry.paneKey)
          run(entry.paneKey)
        },
        Math.max(0, delayMs)
      )
    }
    entry.timer?.unref?.()
    this.byPaneKey.set(paneKey, entry)
  }
}
