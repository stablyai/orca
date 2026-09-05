// Unit 4: owns worktree.ps polling and maps results into DashboardSlice (spec S8).
import type { HudStore } from './hud-store'
import type { DashboardRow } from './hud-store'
import type { RpcPort, RpcSuccess } from '../transport/orca-rpc-wire'

const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_LIMIT = 50

type WorktreePsRow = {
  worktreeId: string
  displayName: string
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  lastOutputAt?: number
}

type WorktreePsResult = { worktrees?: WorktreePsRow[] }

/** Injectable timer so tests can drive polling deterministically without real time. */
export type DashboardTimer = {
  setInterval(cb: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export type WorktreeDashboardInputs = {
  port: RpcPort
  isVisible(): boolean
  isForeground(): boolean
  now(): number
  timer?: DashboardTimer
  pollIntervalMs?: number
  limit?: number
}

/** now-minute-granular elapsed label, e.g. "0m", "12m", "1h05m". Absent lastOutputAt -> undefined. */
export function formatElapsedLabel(lastOutputAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastOutputAt) / 60000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours}h${String(remainder).padStart(2, '0')}m`
}

function toDashboardRow(row: WorktreePsRow, now: number): DashboardRow {
  return {
    worktreeId: row.worktreeId,
    displayName: row.displayName,
    status: row.status,
    elapsedLabel:
      row.lastOutputAt === undefined ? undefined : formatElapsedLabel(row.lastOutputAt, now)
  }
}

const REAL_TIMER: DashboardTimer = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
}

/**
 * Polls worktree.ps every pollIntervalMs while isVisible()+isForeground() are both true;
 * paused otherwise (a tick with either predicate false is skipped, not an error).
 * refreshNow() is the push-nudge hook (foregroundEnter, incoming notification) — it always
 * polls immediately regardless of the visibility predicates.
 */
export class WorktreeDashboardController {
  private readonly timer: DashboardTimer
  private readonly pollIntervalMs: number
  private readonly limit: number
  private intervalHandle: unknown = null
  private pollSeq = 0

  constructor(
    private readonly store: HudStore,
    private readonly inputs: WorktreeDashboardInputs
  ) {
    this.timer = inputs.timer ?? REAL_TIMER
    this.pollIntervalMs = inputs.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.limit = inputs.limit ?? DEFAULT_LIMIT
  }

  start(): void {
    if (this.intervalHandle !== null) {
      return
    }
    this.intervalHandle = this.timer.setInterval(() => this.tick(), this.pollIntervalMs)
    this.tick()
  }

  stop(): void {
    if (this.intervalHandle === null) {
      return
    }
    this.timer.clearInterval(this.intervalHandle)
    this.intervalHandle = null
  }

  refreshNow(): void {
    void this.poll()
  }

  private tick(): void {
    if (!this.inputs.isVisible() || !this.inputs.isForeground()) {
      return
    }
    void this.poll()
  }

  private async poll(): Promise<void> {
    const seq = ++this.pollSeq
    try {
      const response = await this.inputs.port.sendRequest('worktree.ps', { limit: this.limit })
      if (seq !== this.pollSeq) {
        return
      } // superseded by a newer poll; drop this stale response
      if (!response.ok) {
        this.markStale()
        return
      }
      const result = (response as RpcSuccess).result as WorktreePsResult
      const now = this.inputs.now()
      const rows = (result.worktrees ?? []).map((row) => toDashboardRow(row, now))
      this.store.update((s) => ({ ...s, dashboard: { rows, fetchedAt: now, stale: false } }))
    } catch {
      if (seq !== this.pollSeq) {
        return
      }
      this.markStale()
    }
  }

  /** Failure keeps the last-proven rows/fetchedAt (counts kept) and only flips stale. */
  private markStale(): void {
    this.store.update((s) =>
      s.dashboard.stale ? s : { ...s, dashboard: { ...s.dashboard, stale: true } }
    )
  }
}
