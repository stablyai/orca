import { resolveServeBrowserIdleSleepSeconds } from './serve-browser-settings'

const SWEEP_INTERVAL_MS = 60_000

export type OffscreenTabSweeperInventoryEntry = {
  webContentsId: number
  lastActivityAt: number
  hasActiveLease: boolean
}

export type OffscreenTabSweeperPorts = {
  getInventory: () => Map<string, OffscreenTabSweeperInventoryEntry>
  sleepPage: (pageId: string) => Promise<void>
}

/**
 * Periodically destroys idle offscreen pages to reclaim their renderer memory.
 * Pages held by a paint lease (live screencast/screenshot) are never swept; the
 * idle threshold is re-read each sweep so live settings changes apply.
 */
export class OffscreenTabSweeper {
  private interval: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  constructor(private readonly ports: OffscreenTabSweeperPorts) {}

  start(): void {
    if (this.interval) {
      return
    }
    this.interval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.interval.unref?.()
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  /** Sleeps the least-recently-used pages idle past the configured seconds; 0 disables. */
  sweep(): string[] {
    const idleSeconds = resolveServeBrowserIdleSleepSeconds()
    if (this.sweeping || idleSeconds <= 0) {
      return []
    }
    this.sweeping = true
    const slept: string[] = []
    try {
      const idleCutoff = Date.now() - idleSeconds * 1000
      const candidates = [...this.ports.getInventory()]
        .filter(([, entry]) => !entry.hasActiveLease && entry.lastActivityAt <= idleCutoff)
        .sort(([, a], [, b]) => a.lastActivityAt - b.lastActivityAt)
      for (const [pageId] of candidates) {
        void this.ports.sleepPage(pageId)
        slept.push(pageId)
      }
    } finally {
      this.sweeping = false
    }
    return slept
  }
}
