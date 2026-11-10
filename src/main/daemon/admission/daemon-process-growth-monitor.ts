import { readProcessTable } from '../../pty/process-retirement/pty-descendant-termination'
import {
  isWindowsProcessTableAvailable,
  readWindowsProcessIdentityTableFresh
} from '../../windows/windows-process-table'
import type { HostPressureLevel } from '../../../shared/terminal/pty/admission/spawn-admission-contract'
import {
  cgroupPidsPressure,
  createCgroupPidsReader,
  type CgroupPidsDirectories,
  type CgroupPidsUsage
} from './cgroup-pids-headroom'
import {
  countDescendantsByRoot,
  createProcessGrowthState,
  DEFAULT_PROCESS_GROWTH_LIMITS,
  evaluateProcessGrowth,
  type ProcessGrowthLimits,
  type ProcessGrowthTrip
} from '../../../shared/process-growth-breaker'

type ProcessRow = { pid: number; ppid: number }

const ACTIVE_SAMPLE_INTERVAL_MS = 5_000
const IDLE_SAMPLE_INTERVAL_MS = 30_000
// Admission re-reads the task limit at most this often.
const PIDS_REFRESH_MS = 1_000
// A task-limit read that takes longer than this is abandoned (and admission stops waiting on it).
const PIDS_READ_BOUND_MS = 2_000
const MAX_REPORTED_TRIPS = 5

/** Return null when process inventory cannot be read. */
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

export type HostPressureCause = 'process-growth' | 'cgroup-pids'

type DaemonProcessGrowthMonitorOptions = {
  listSessions: () => readonly { sessionId: string; pid: number | null }[]
  recentAutomaticWork: () => boolean
  /** Avoid idle process-table reads on observe-only hosts. */
  sampleWhenIdle: boolean
  /** `cause` names what set the level: the growth breaker, or the cgroup task limit. */
  onLevelChanged: (level: HostPressureLevel, cause: HostPressureCause) => void
  onTrip: (trips: readonly ProcessGrowthTrip[]) => void
  /** Each cgroup task-limit reading and its pressure; the first one is the startup limit. */
  onPidsUsage?: (usage: CgroupPidsUsage | null, level: HostPressureLevel, first: boolean) => void
  /** A task-limit read did not finish in time and was abandoned; admission went ahead without it. */
  onPidsReadStalled?: (waitedMs: number) => void
  readRows?: () => Promise<ProcessRow[] | null>
  readPids?: () => Promise<CgroupPidsUsage | null>
  /** Where the task caps were found, once; a `problem` means protection is off on this host. */
  onPidsDirectories?: (resolution: CgroupPidsDirectories) => void
  rootPid?: number
  limits?: ProcessGrowthLimits
  now?: () => number
}

/** Report descendant growth to admission control without killing processes. */
export class DaemonProcessGrowthMonitor {
  private readonly state = createProcessGrowthState()
  private readonly limits: ProcessGrowthLimits
  private readonly now: () => number
  private readonly readRows: () => Promise<ProcessRow[] | null>
  private readonly readPids: () => Promise<CgroupPidsUsage | null>
  private pidsRead = false
  private pidsAttempted = false
  private abandonedRead: Promise<void> | null = null
  private pidsLevel: HostPressureLevel = 'ok'
  private pidsReadAt = Number.NEGATIVE_INFINITY
  private pidsReading: Promise<void> | null = null
  private growthLevel: HostPressureLevel = 'unknown'
  private currentLevel: HostPressureLevel = 'unknown'
  private rising = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: DaemonProcessGrowthMonitorOptions) {
    this.limits = options.limits ?? DEFAULT_PROCESS_GROWTH_LIMITS
    this.now = options.now ?? Date.now
    this.readRows = options.readRows ?? readDaemonProcessRows
    this.readPids =
      options.readPids ??
      createCgroupPidsReader((resolved) => options.onPidsDirectories?.(resolved))
  }

  get level(): HostPressureLevel {
    return this.currentLevel
  }

  /** Admission's view. Each admission also refreshes the task-limit reading, so a spawn wave
   *  sees its own processes and threads instead of waiting for the next 5-30 s sample. The read
   *  lands after this decision, and an agent's threads keep arriving for seconds after it starts;
   *  the 10% margin below the cap covers that lag. */
  admissionLevel(): HostPressureLevel {
    void this.refreshPids()
    return this.currentLevel
  }

  start(): void {
    void this.refreshPids()
    this.schedule()
  }

  /** Until the first task-limit reading lands, admission must wait for it: a host that starts
   *  above 90% of its cap would otherwise admit its whole restore wave first. */
  initialReading(): Promise<void> | null {
    return this.pidsAttempted || this.stopped ? null : this.refreshPids()
  }

  /** A cgroup pids.max counts every thread, so growth sampling alone cannot see it coming (#40327).
   *  Every read is bounded: a stalled read (FUSE, an odd container filesystem) is abandoned so it
   *  can hold neither admission nor the sampling loop, and the next refresh retries it. */
  private refreshPids(): Promise<void> {
    if (this.pidsReading || this.abandonedRead || this.now() - this.pidsReadAt < PIDS_REFRESH_MS) {
      // An abandoned read still holds its threadpool threads and fds; never stack another on it.
      return this.pidsReading ?? Promise.resolve()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => resolve('stalled'), PIDS_READ_BOUND_MS)
      timer.unref?.()
    })
    const reading = this.readPids().then((pids) => ({ pids }))
    const settled = reading.then(
      () => {},
      () => {}
    )
    const attempt = Promise.race([reading, stalled])
      .then((outcome) => {
        if (this.stopped) {
          return
        }
        if (outcome === 'stalled') {
          // Keep the last level and read again only once the stalled read settles.
          this.abandonedRead = settled
          this.options.onPidsReadStalled?.(PIDS_READ_BOUND_MS)
          void settled.then(() => {
            if (this.abandonedRead === settled) {
              this.abandonedRead = null
            }
          })
          return
        }
        this.pidsReadAt = this.now()
        this.pidsLevel = cgroupPidsPressure(outcome.pids, this.pidsLevel)
        this.options.onPidsUsage?.(outcome.pids, this.pidsLevel, !this.pidsRead)
        this.pidsRead = true
        this.publishLevel()
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        if (this.pidsReading === attempt) {
          this.pidsReading = null
        }
        // A failed or stalled first read must not hold admission forever.
        this.pidsAttempted = true
      })
    this.pidsReading = attempt
    return attempt
  }

  private publishLevel(): void {
    const byPids = this.pidsLevel === 'critical'
    this.setLevel(byPids ? 'critical' : this.growthLevel, byPids ? 'cgroup-pids' : 'process-growth')
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async sample(): Promise<void> {
    await this.refreshPids()
    if (this.stopped) {
      return
    }
    const sessions = this.options.listSessions().filter((session) => session.pid !== null)
    if (sessions.length === 0) {
      this.growthLevel = 'ok'
      this.publishLevel()
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
    // Growth trips stand on their own, whatever the task-limit reading says meanwhile.
    const wasCritical = this.growthLevel === 'critical'
    this.growthLevel = verdict.level
    this.publishLevel()
    if (verdict.level === 'critical' && !wasCritical) {
      this.options.onTrip(
        [...verdict.trips]
          .sort((a, b) => b.growthPerSecond - a.growthPerSecond)
          .slice(0, MAX_REPORTED_TRIPS)
      )
    }
  }

  private setLevel(level: HostPressureLevel, cause: HostPressureCause): void {
    if (level !== this.currentLevel) {
      this.currentLevel = level
      this.options.onLevelChanged(level, cause)
    }
  }

  private schedule(): void {
    if (this.stopped) {
      return
    }
    // Confirm growth with short samples; a large tree alone keeps the slow cadence.
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
        .catch(() => {
          this.growthLevel = 'unknown'
          this.publishLevel()
        })
        .finally(() => this.schedule())
    }, delayMs)
    this.timer.unref?.()
  }
}
