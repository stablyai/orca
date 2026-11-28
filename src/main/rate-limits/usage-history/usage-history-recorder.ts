import { readFile } from 'node:fs/promises'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  listUsageWindowSlots,
  pruneEndedUsageHistory,
  recordUsageWindowSample,
  usageHistoryKey,
  type UsageHistoryByWindow
} from '../../../shared/agent-usage/rate-limits/usage-window-history'
import {
  parseUsageHistoryFile,
  serializeUsageHistoryFile,
  USAGE_HISTORY_FILE_MAX_BYTES,
  usageReadingAccountKey,
  type AccountUsageSeries,
  type PersistedUsageHistory
} from './usage-history-file'

const SAVE_DELAY_MS = 5_000
// Every window of every account a host has read in one window's span stays far below this.
export const USAGE_HISTORY_MAX_SERIES = 128
const MAX_PENDING_READINGS = 32

type UsageState = Record<string, ProviderRateLimits | null>

const seriesKey = (provider: string, account: string, windowId: string): string =>
  JSON.stringify([provider, account, windowId])

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readSavedHistory(filePath: string): Promise<PersistedUsageHistory> {
  try {
    const text = await readFile(filePath, 'utf8')
    if (text.length > USAGE_HISTORY_FILE_MAX_BYTES) {
      console.warn('[rate-limits] Usage history file is too large; starting fresh')
      return { activeAccounts: {}, series: [] }
    }
    return parseUsageHistoryFile(JSON.parse(text))
  } catch (error) {
    if (!isEnoent(error)) {
      console.warn('[rate-limits] Unreadable usage history; starting fresh', error)
    }
    return { activeAccounts: {}, series: [] }
  }
}

/** Samples each active provider window's used percent at every usage reading; no fetches of its own.
 *  Series are kept per provider account, and the graph shows the account read last. */
export class UsageHistoryRecorder {
  private readonly series = new Map<string, AccountUsageSeries>()
  private readonly activeAccounts = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> | null = null
  private dirty = false
  private readonly lastReadingAt = new Map<string, number>()
  // Readings before the file loads replay onto it, so a restored reading cannot replace saved history.
  private pending: { state: UsageState; now: number }[] | null = []
  /** Settles once the saved history has been loaded and any earlier readings replayed onto it. */
  readonly loaded: Promise<void>

  constructor(private readonly filePath: string | null) {
    this.loaded = (filePath ? readSavedHistory(filePath) : Promise.resolve(null)).then(
      (saved: PersistedUsageHistory | null) => {
        for (const entry of saved?.series ?? []) {
          this.series.set(seriesKey(entry.provider, entry.account, entry.windowId), entry)
        }
        for (const [provider, account] of Object.entries(saved?.activeAccounts ?? {})) {
          this.activeAccounts.set(provider, account)
        }
        const pending = this.pending ?? []
        this.pending = null
        this.prune(Date.now())
        for (const reading of pending) {
          this.record(reading.state, reading.now)
        }
      }
    )
  }

  record(state: UsageState, now: number = Date.now()): void {
    if (this.pending) {
      this.pending.push({ state: { ...state }, now })
      this.pending.splice(0, Math.max(0, this.pending.length - MAX_PENDING_READINGS))
      return
    }
    let changed = false
    for (const [slotKey, limits] of Object.entries(state)) {
      // Only fresh successful readings: an error keeps the last windows, which are not a new reading.
      if (
        !limits ||
        limits.status !== 'ok' ||
        this.lastReadingAt.get(slotKey) === limits.updatedAt
      ) {
        continue
      }
      this.lastReadingAt.set(slotKey, limits.updatedAt)
      // Keyed by the provider id mobile reads, so the graph finds its window whatever the state slot is called.
      const provider = limits.provider
      const account = usageReadingAccountKey(limits)
      if (!this.activeAccounts.has(provider) && account !== '') {
        this.adoptUnattributedSeries(provider, account)
      }
      if (this.activeAccounts.get(provider) !== account) {
        this.activeAccounts.set(provider, account)
        changed = true
      }
      for (const slot of listUsageWindowSlots(limits)) {
        const { window } = slot
        if (window.windowMinutes <= 0 || (window.resetsAt !== null && window.resetsAt <= now)) {
          continue
        }
        const key = seriesKey(provider, account, slot.id)
        const history = recordUsageWindowSample(
          this.series.get(key)?.history,
          window,
          limits.updatedAt || now
        )
        this.series.set(key, { provider, account, windowId: slot.id, history })
        changed = true
      }
    }
    if (changed) {
      this.prune(now)
      this.scheduleSave()
    }
  }

  /** The active account's current windows, keyed `${provider}:${windowId}` as clients read them. */
  snapshot(now: number = Date.now()): UsageHistoryByWindow {
    const shown: UsageHistoryByWindow = {}
    for (const entry of this.series.values()) {
      if (entry.account === (this.activeAccounts.get(entry.provider) ?? '')) {
        shown[usageHistoryKey(entry.provider, entry.windowId)] = entry.history
      }
    }
    return pruneEndedUsageHistory(shown, now)
  }

  /** Writes now instead of after the save delay; used when the service stops.
   *  Waits for the file so a reading that arrived while it was loading is kept with the saved samples. */
  async flush(): Promise<void> {
    await this.loaded
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      await this.save()
      return
    }
    await this.saving
  }

  /** A version 1 file kept no accounts: its series belong to whichever login is read first. */
  private adoptUnattributedSeries(provider: string, account: string): void {
    for (const [key, entry] of this.series) {
      if (entry.provider === provider && entry.account === '') {
        this.series.delete(key)
        this.series.set(seriesKey(provider, account, entry.windowId), { ...entry, account })
      }
    }
  }

  /** Drops ended windows, then the stalest series past the cap, keeping active accounts first. */
  private prune(now: number): void {
    const entries = [...this.series.entries()]
    const live = pruneEndedUsageHistory(
      Object.fromEntries(entries.map(([key, entry]) => [key, entry.history])),
      now
    )
    const isActive = (entry: AccountUsageSeries): boolean =>
      entry.account === (this.activeAccounts.get(entry.provider) ?? '')
    const kept = entries
      .filter(([key]) => key in live)
      .sort(
        ([, a], [, b]) =>
          Number(isActive(b)) - Number(isActive(a)) ||
          (b.history.samples.at(-1)?.at ?? 0) - (a.history.samples.at(-1)?.at ?? 0)
      )
      .slice(0, USAGE_HISTORY_MAX_SERIES)
    this.series.clear()
    for (const [key, entry] of kept) {
      this.series.set(key, entry)
    }
    const providers = new Set(kept.map(([, entry]) => entry.provider))
    for (const provider of this.activeAccounts.keys()) {
      if (!providers.has(provider)) {
        this.activeAccounts.delete(provider)
      }
    }
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

  private async save(): Promise<void> {
    if (!this.filePath) {
      return
    }
    if (this.saving) {
      this.dirty = true
      return
    }
    const contents = serializeUsageHistoryFile({
      activeAccounts: Object.fromEntries(this.activeAccounts),
      series: [...this.series.values()]
    })
    this.saving = writePluginFileAtomically(this.filePath, contents, { mode: 0o600 }).catch(
      (error: unknown) => console.warn('[rate-limits] Failed to save usage history', error)
    )
    await this.saving
    this.saving = null
    if (this.dirty) {
      this.dirty = false
      await this.save()
    }
  }
}
