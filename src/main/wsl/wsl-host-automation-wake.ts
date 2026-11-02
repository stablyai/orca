/**
 * E9: a WSL host's automations run inside its distro, so a stopped distro misses them. While a host
 * is connected (and after this desktop changes its automations) the desktop learns its enabled
 * schedules and keeps them across restarts; when the soonest run comes due with the host off, this
 * boots the distro once and orcad's startup catch-up fires the run. A due run is the user's own
 * standing request, so it is the one non-interactive wake. Nothing here boots a distro to check.
 * A run due while this desktop last saw the host ready already ran there, so it never wakes it.
 */
import type { Automation } from '../../shared/automations-types'
import { nextAutomationOccurrenceAfter } from '../../shared/automation-schedule-occurrences'

export type WslHostAutomationSchedule = {
  rrule: string
  dtstart: number
  missedRunGraceMinutes: number
}

export type WslHostAutomationDue = {
  nextRunAt: number
  /** Past this, orcad would only record the run as missed, so a wake is pointless. */
  wakeUntil: number
  /** Every enabled schedule, so the next due time survives a run handled while off. */
  schedules: WslHostAutomationSchedule[]
  /** When this desktop last saw the host ready: a run due by then ran on the host, so it never wakes it. */
  lastSeenReadyAt: number
}

export type WslHostAutomationWakeDeps = {
  load: () => Record<string, WslHostAutomationDue>
  save: (due: Record<string, WslHostAutomationDue>) => void
  listAutomations: (environmentId: string) => Promise<Automation[]>
  /**
   * Whether the host's server answers through this process now; never starts a stopped distro.
   * False is not "stopped": a fresh process has no bridge yet, and the wake then just connects.
   */
  isConnected: (environmentId: string) => Promise<boolean>
  /** Boots the host's distro and connects; it may refuse (host removed, gate closed). */
  wake: (environmentId: string) => Promise<void>
  now?: () => number
  setTimer?: (delayMs: number, task: () => void) => () => void
}

// Re-arm at least this often, so a clock change or sleep can't strand a far-off timer.
const MAX_TIMER_MS = 60 * 60 * 1000
// orcad's own tick jitter allowance on top of each automation's grace.
const GRACE_SLACK_MS = 2 * 60 * 1000

/** The soonest enabled run and the schedules behind it, or null when nothing is scheduled. */
export function earliestWslHostAutomationDue(
  automations: readonly Automation[],
  lastSeenReadyAt: number
): WslHostAutomationDue | null {
  const enabled = automations.filter(
    (automation) => automation.enabled && Number.isFinite(automation.nextRunAt)
  )
  const soonest = enabled.reduce<Automation | null>(
    (best, automation) => (!best || automation.nextRunAt < best.nextRunAt ? automation : best),
    null
  )
  return soonest
    ? {
        nextRunAt: soonest.nextRunAt,
        wakeUntil: graceEnd(soonest.nextRunAt, soonest.missedRunGraceMinutes),
        schedules: enabled.map(({ rrule, dtstart, missedRunGraceMinutes }) => ({
          rrule,
          dtstart,
          missedRunGraceMinutes
        })),
        lastSeenReadyAt
      }
    : null
}

/** The next due run strictly after `after`, from the learned schedules. */
export function nextWslHostAutomationDue(
  schedules: readonly WslHostAutomationSchedule[],
  after: number,
  lastSeenReadyAt: number
): WslHostAutomationDue | null {
  let due: WslHostAutomationDue | null = null
  for (const schedule of schedules) {
    let nextRunAt: number
    try {
      nextRunAt = nextAutomationOccurrenceAfter(schedule.rrule, schedule.dtstart, after)
    } catch {
      continue
    }
    if (Number.isFinite(nextRunAt) && (!due || nextRunAt < due.nextRunAt)) {
      due = {
        nextRunAt,
        wakeUntil: graceEnd(nextRunAt, schedule.missedRunGraceMinutes),
        schedules: [...schedules],
        lastSeenReadyAt
      }
    }
  }
  return due
}

function graceEnd(nextRunAt: number, graceMinutes: number): number {
  return nextRunAt + graceMinutes * 60_000 + GRACE_SLACK_MS
}

export class WslHostAutomationWake {
  private due: Record<string, WslHostAutomationDue>
  private cancelTimer: (() => void) | null = null
  private readonly now: () => number
  private readonly setTimer: (delayMs: number, task: () => void) => () => void

  constructor(private readonly deps: WslHostAutomationWakeDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((delayMs, task) => {
        const timer = setTimeout(task, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    this.due = deps.load()
  }

  /** Arms the timer from what earlier runs learned; a run due during a reboot fires now. */
  start(): void {
    this.arm()
  }

  /** Called while the host is connected; a failed read keeps what was known. */
  async learn(environmentId: string): Promise<void> {
    // Only a ready host is read, so it is seen ready now even when the read fails.
    const readyAt = this.now()
    const known = this.due[environmentId]
    if (known) {
      this.set(environmentId, { ...known, lastSeenReadyAt: readyAt })
      this.persist()
    }
    let next: WslHostAutomationDue | null
    try {
      next = earliestWslHostAutomationDue(await this.deps.listAutomations(environmentId), readyAt)
    } catch {
      return
    }
    this.set(environmentId, next)
    this.persist()
    this.arm()
  }

  forget(environmentId: string): void {
    this.set(environmentId, null)
    this.persist()
    this.arm()
  }

  dispose(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
  }

  private set(environmentId: string, next: WslHostAutomationDue | null): void {
    const { [environmentId]: _previous, ...rest } = this.due
    this.due = next ? { ...rest, [environmentId]: next } : rest
  }

  private persist(): void {
    try {
      this.deps.save(this.due)
    } catch (error) {
      console.warn('[wsl-hosts] Could not save automation wake times:', error)
    }
  }

  private arm(): void {
    this.cancelTimer?.()
    const times = Object.values(this.due).map((entry) => entry.nextRunAt)
    if (times.length === 0) {
      this.cancelTimer = null
      return
    }
    const delayMs = Math.min(Math.max(0, Math.min(...times) - this.now()), MAX_TIMER_MS)
    this.cancelTimer = this.setTimer(delayMs, () => void this.fire())
  }

  private async fire(): Promise<void> {
    const now = this.now()
    for (const [environmentId, snapshot] of Object.entries(this.due)) {
      // A learn or forget during an earlier host's wake may have refreshed or cleared this entry.
      const entry = this.due[environmentId]
      if (!entry || entry.nextRunAt > now) {
        continue
      }
      const missed = missedRunAfterLastReady(entry, now)
      const lastSeenReadyAt = Math.max(snapshot.lastSeenReadyAt, entry.lastSeenReadyAt)
      // Keep the following run whatever happens to this one; a connect re-learns the truth.
      this.set(environmentId, nextWslHostAutomationDue(entry.schedules, now, lastSeenReadyAt))
      // Saved before the boot, so a quit while it runs can't repeat this wake at the next launch.
      this.persist()
      if (await this.deps.isConnected(environmentId)) {
        // Its own scheduler ran it; read the real next run instead of the local estimate.
        await this.learn(environmentId)
        continue
      }
      if (!missed || now > missed.wakeUntil) {
        continue
      }
      await this.deps.wake(environmentId).catch((error: unknown) => {
        console.warn(`[wsl-hosts] Could not start ${environmentId} for a scheduled run:`, error)
      })
    }
    this.persist()
    this.arm()
  }
}

/** The run that came due after the host was last seen ready, if one has by `now`: only it was missed. */
function missedRunAfterLastReady(
  entry: WslHostAutomationDue,
  now: number
): WslHostAutomationDue | null {
  if (entry.nextRunAt > entry.lastSeenReadyAt) {
    return entry
  }
  const later = nextWslHostAutomationDue(
    entry.schedules,
    entry.lastSeenReadyAt,
    entry.lastSeenReadyAt
  )
  return later && later.nextRunAt <= now ? later : null
}
