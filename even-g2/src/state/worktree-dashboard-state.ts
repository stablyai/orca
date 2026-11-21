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
  // Nullable, not just optional: orca-runtime-record-pty-worktree.ts sends
  // `lastOutputAt: state.lastOutputAt ?? null` — a row with no recorded output arrives as
  // an explicit null, which must be treated the same as "absent" (see toDashboardRow).
  lastOutputAt?: number | null
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
    // `== null` deliberately covers both undefined AND null: worktree.ps rows send an explicit
    // null for "no activity time" (never undefined), and treating null as epoch-0 previously
    // produced multi-decade elapsed labels.
    elapsedLabel: row.lastOutputAt == null ? undefined : formatElapsedLabel(row.lastOutputAt, now)
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
  // MEDIUM #6/#9: first-seen sequence per worktreeId, rebuilt (continuing ids keep their seq,
  // vanished ones drop out) every poll — the stable tiebreak below so ties never shuffle just
  // because the host happened to return worktrees in a different order this time.
  private firstSeenSeq = new Map<string, number>()
  private seqCounter = 0

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
      const rows = this.orderRows((result.worktrees ?? []).map((row) => toDashboardRow(row, now)))
      this.store.update((s) => ({ ...s, dashboard: { rows, fetchedAt: now, stale: false } }))
    } catch {
      if (seq !== this.pollSeq) {
        return
      }
      this.markStale()
    }
  }

  /**
   * MEDIUM #6 — glanceability: worktrees needing input surface first, so the header/first page
   * says what's urgent without scrolling. MEDIUM #9 — flicker: rows sharing a tier (the common
   * case — a status flip that isn't into/out of `permission`, or just an elapsedLabel tick) keep
   * their EXISTING relative order via `firstSeenSeq` rather than whatever order the host
   * returned them in this poll, so the dashboard AND worktree-list screens (both read this same
   * array) don't reshuffle every 5s poll and reset the firmware's row selection. A worktree
   * entering/leaving `permission` is the one case that still reorders — an intentional,
   * infrequent exception to make the urgent row visible, not the every-poll flicker this guards
   * against. */
  private orderRows(rows: DashboardRow[]): DashboardRow[] {
    const nextSeen = new Map<string, number>()
    for (const row of rows) {
      const existing = this.firstSeenSeq.get(row.worktreeId)
      nextSeen.set(row.worktreeId, existing ?? this.seqCounter++)
    }
    this.firstSeenSeq = nextSeen
    const rank = (row: DashboardRow): number => (row.status === 'permission' ? 0 : 1)
    return [...rows].sort((a, b) => {
      const rankDiff = rank(a) - rank(b)
      if (rankDiff !== 0) {
        return rankDiff
      }
      return (nextSeen.get(a.worktreeId) ?? 0) - (nextSeen.get(b.worktreeId) ?? 0)
    })
  }

  /** Failure keeps the last-proven rows/fetchedAt (counts kept) and only flips stale. */
  private markStale(): void {
    this.store.update((s) =>
      s.dashboard.stale ? s : { ...s, dashboard: { ...s.dashboard, stale: true } }
    )
  }
}
