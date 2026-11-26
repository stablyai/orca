import { readFile } from 'node:fs/promises'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  listUsageWindowSlots,
  parseUsageHistory,
  pruneEndedUsageHistory,
  recordUsageWindowSample,
  usageHistoryKey,
  type UsageHistoryByWindow
} from '../../../shared/agent-usage/rate-limits/usage-window-history'

const SAVE_DELAY_MS = 5_000

/** Samples each active provider window's used percent at every usage reading; no fetches of its own. */
export class UsageHistoryRecorder {
  private history: UsageHistoryByWindow = {}
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> | null = null
  private dirty = false
  private readonly lastReadingAt = new Map<string, number>()
  /** Settles once the saved history has been merged in. */
  readonly loaded: Promise<void>
  /** Writes already queued, including follow-ups marked dirty while one was in flight. */
  private drain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string | null) {
    this.loaded = !filePath
      ? Promise.resolve()
      : readFile(filePath, 'utf8')
          .then((text) => parseUsageHistory(JSON.parse(text)))
          .catch(() => ({}))
          .then((saved) => {
            // Replay startup readings onto the saved series. A spread would drop every saved sample for that key.
            let history = saved
            for (const [key, series] of Object.entries(this.history)) {
              for (const sample of series.samples) {
                history = {
                  ...history,
                  [key]: recordUsageWindowSample(
                    history[key],
                    {
                      usedPercent: sample.usedPercent,
                      windowMinutes: series.windowMinutes,
                      resetsAt: series.resetsAt
                    },
                    sample.at
                  )
                }
              }
            }
            this.history = pruneEndedUsageHistory(history, Date.now())
          })
  }

  record(state: Record<string, ProviderRateLimits | null>, now: number = Date.now()): void {
    let changed = false
    for (const [provider, limits] of Object.entries(state)) {
      // Only fresh successful readings: an error keeps the last windows, which are not a new reading.
      if (
        !limits ||
        limits.status !== 'ok' ||
        this.lastReadingAt.get(provider) === limits.updatedAt
      ) {
        continue
      }
      this.lastReadingAt.set(provider, limits.updatedAt)
      for (const slot of listUsageWindowSlots(limits)) {
        const { window } = slot
        if (window.windowMinutes <= 0 || (window.resetsAt !== null && window.resetsAt <= now)) {
          continue
        }
        // Keyed by the provider id mobile reads, so the graph finds its window whatever the state slot is called.
        const key = usageHistoryKey(limits.provider, slot.id)
        this.history[key] = recordUsageWindowSample(
          this.history[key],
          window,
          limits.updatedAt || now
        )
        changed = true
      }
    }
    if (changed) {
      this.history = pruneEndedUsageHistory(this.history, now)
      this.scheduleSave()
    }
  }

  snapshot(now: number = Date.now()): UsageHistoryByWindow {
    return pruneEndedUsageHistory(this.history, now)
  }

  /** Writes now instead of after the save delay; used when the service stops. */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      return this.save()
    }
    return this.saving ?? Promise.resolve()
  }

  private scheduleSave(): void {
    if (!this.filePath || this.saveTimer) {
      return
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private save(): Promise<void> {
    if (!this.filePath) {
      return Promise.resolve()
    }
    this.dirty = true
    const filePath = this.filePath
    this.drain = this.drain.then(async () => {
      while (this.dirty) {
        this.dirty = false
        await writePluginFileAtomically(filePath, JSON.stringify(this.history), {
          mode: 0o600
        }).catch((error: unknown) =>
          console.warn('[rate-limits] Failed to save usage history', error)
        )
      }
    })
    this.saving = this.drain
    return this.drain
  }
}
