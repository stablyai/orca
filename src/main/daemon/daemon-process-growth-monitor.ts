import { readProcessTable } from '../pty-descendant-termination'
import {
  isWindowsProcessTableAvailable,
  readWindowsProcessIdentityTableFresh
} from '../windows/windows-process-table'
import type { HostPressureLevel } from '../../shared/host-spawn-admission'
import {
  countDescendantsByRoot,
  createProcessGrowthState,
  DEFAULT_PROCESS_GROWTH_LIMITS,
  evaluateProcessGrowth,
  type ProcessGrowthLimits,
  type ProcessGrowthTrip
} from '../../shared/process-growth-breaker'

type ProcessRow = { pid: number; ppid: number }

const ACTIVE_SAMPLE_INTERVAL_MS = 5_000
const IDLE_SAMPLE_INTERVAL_MS = 30_000
const MAX_REPORTED_TRIPS = 5

/** pid/ppid rows from a child process (POSIX `ps`) or the native Windows table; null when unreadable. */
export async function readDaemonProcessRows(): Promise<ProcessRow[] | null> {
  try {
    if (process.platform === 'win32') {
      return isWindowsProcessTableAvailable() ? await readWindowsProcessIdentityTableFresh() : null
    }
    return (await readProcessTable()).rows
  } catch {
    return null
  }
}

type DaemonProcessGrowthMonitorOptions = {
  listSessions: () => readonly { sessionId: string; pid: number | null }[]
  /** Samples fast while automatic work started recently, slowly otherwise. */
  recentAutomaticWork: () => boolean
  /** Why: an observe-only host has nothing to protect, so it pays for `ps` only around restores. */
  sampleWhenIdle: boolean
  onLevelChanged: (level: HostPressureLevel) => void
  onTrip: (trips: readonly ProcessGrowthTrip[]) => void
  readRows?: () => Promise<ProcessRow[] | null>
  rootPid?: number
  limits?: ProcessGrowthLimits
  now?: () => number
}

/**
 * Watches the daemon's descendant tree, per terminal and in total. It never kills:
 * a trip only closes admission of automatic work and reports which terminals grew.
 */
export class DaemonProcessGrowthMonitor {
  private readonly state = createProcessGrowthState()
  private readonly limits: ProcessGrowthLimits
  private readonly now: () => number
  private readonly readRows: () => Promise<ProcessRow[] | null>
  private currentLevel: HostPressureLevel = 'unknown'
  private rising = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: DaemonProcessGrowthMonitorOptions) {
    this.limits = options.limits ?? DEFAULT_PROCESS_GROWTH_LIMITS
    this.now = options.now ?? Date.now
    this.readRows = options.readRows ?? readDaemonProcessRows
  }

  get level(): HostPressureLevel {
    return this.currentLevel
  }

  start(): void {
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async sample(): Promise<void> {
    const sessions = this.options.listSessions().filter((session) => session.pid !== null)
    if (sessions.length === 0) {
      this.setLevel('ok')
      return
    }
    const rows = await this.readRows()
    if (this.stopped) {
      return
    }
    const rootPid = this.options.rootPid ?? process.pid
    const counts = rows
      ? countDescendantsByRoot(rows, [rootPid, ...sessions.map((session) => session.pid ?? 0)])
      : null
    const verdict = evaluateProcessGrowth(
      this.state,
      {
        atMs: this.now(),
        hostDescendants: counts?.get(rootPid) ?? null,
        scopes: new Map(
          counts
            ? sessions.map((session) => [session.sessionId, counts.get(session.pid ?? 0) ?? 0])
            : []
        )
      },
      this.limits
    )
    this.rising = verdict.rising
    const wasCritical = this.currentLevel === 'critical'
    this.setLevel(verdict.level)
    if (verdict.level === 'critical' && !wasCritical) {
      this.options.onTrip(
        [...verdict.trips]
          .sort((a, b) => b.growthPerSecond - a.growthPerSecond)
          .slice(0, MAX_REPORTED_TRIPS)
      )
    }
  }

  private setLevel(level: HostPressureLevel): void {
    if (level !== this.currentLevel) {
      this.currentLevel = level
      this.options.onLevelChanged(level)
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return
    }
    // Why rising samples fast: a growing tree is confirmed over several short samples, never
    // tripped on one long idle interval; a merely large tree keeps the slow cadence.
    const confirming = this.rising || this.currentLevel === 'critical'
    const delayMs =
      this.options.recentAutomaticWork() || confirming
        ? ACTIVE_SAMPLE_INTERVAL_MS
        : IDLE_SAMPLE_INTERVAL_MS
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.options.sampleWhenIdle && !this.options.recentAutomaticWork() && !confirming) {
        this.schedule()
        return
      }
      void this.sample()
        .catch(() => this.setLevel('unknown'))
        .finally(() => this.schedule())
    }, delayMs)
    this.timer.unref?.()
  }
}
