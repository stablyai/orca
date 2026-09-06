/**
 * Paces the wakes that inbound orchestration mail asks for.
 *
 * Two independent bounds, both caller-side — the mount door keeps no bookkeeping
 * of its own, mirroring the close-intent guard (`web-session-close-intent.ts`):
 *  - per-pane suppression after a successful request, so repeat mail cannot
 *    restart a wake already in progress;
 *  - a minimum spacing between wakes, so one `@all` broadcast spreads its wakes
 *    instead of respawning a workspace at once. Queued wakes still happen.
 */

/** Mirrors the PTY wait `terminal.subscribe` allows a mount it just requested. */
export const SLEEPING_PANE_WAKE_MOUNT_SETTLE_MS = 10_000

/** Why derived: a wake is only observable once the pane has remounted AND its
 *  agent has cold-restored. Re-asking inside that window cannot learn anything
 *  new, so the TTL must outlast the mount wait plus the resume it triggers. */
const WAKE_RESUME_GRACE_MS = 20_000
export const SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS =
  SLEEPING_PANE_WAKE_MOUNT_SETTLE_MS + WAKE_RESUME_GRACE_MS

export const SLEEPING_PANE_WAKE_SPACING_MS = 1_500

export type SleepingPaneWakeRequest = {
  paneKey: string
  worktreeId: string
  tabId?: string
  ptyId?: string
}

export type SleepingPaneWakeOutcome = 'requested' | 'queued' | 'suppressed'

/** Node returns a Timeout, jsdom/browser a number; neither is unref-able for sure. */
type SleepingPaneWakeTimer = { unref?: () => void } | number

type SleepingPaneWakeSchedulerDependencies = {
  wake: (request: SleepingPaneWakeRequest) => boolean
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => SleepingPaneWakeTimer
  cancel?: (timer: SleepingPaneWakeTimer) => void
}

export class SleepingPaneWakeScheduler {
  private readonly requestedAtByPaneKey = new Map<string, number>()
  // One row per slept pane, independent of message volume.
  private readonly queue = new Map<string, { request: SleepingPaneWakeRequest; failures: number }>()
  private readonly failed = new Map<string, SleepingPaneWakeRequest>()
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private drainTimer: SleepingPaneWakeTimer | null = null
  private pruneTimer: SleepingPaneWakeTimer | null = null

  constructor(private readonly deps: SleepingPaneWakeSchedulerDependencies) {}

  request(request: SleepingPaneWakeRequest): SleepingPaneWakeOutcome {
    const now = this.now()
    this.pruneSuppressions(now)
    if (this.requestedAtByPaneKey.has(request.paneKey) || this.queue.has(request.paneKey)) {
      return 'suppressed'
    }
    // A new arrival is an event-driven retry for a request parked after its one
    // automatic retry. Keep the newest coordinates in case the tab reminted.
    this.failed.delete(request.paneKey)
    if (now - this.lastAttemptAt >= SLEEPING_PANE_WAKE_SPACING_MS && this.queue.size === 0) {
      if (this.fire(request, now)) {
        return 'requested'
      }
      this.queue.set(request.paneKey, { request, failures: 1 })
      this.scheduleDrain(now)
      return 'queued'
    }
    this.queue.set(request.paneKey, { request, failures: 0 })
    this.scheduleDrain(now)
    return 'queued'
  }

  /** Retry parked failures when renderer readiness provides new wake capacity. */
  retryPending(): void {
    for (const [paneKey, request] of this.failed) {
      if (!this.requestedAtByPaneKey.has(paneKey) && !this.queue.has(paneKey)) {
        this.queue.set(paneKey, { request, failures: 0 })
      }
    }
    this.failed.clear()
    if (this.queue.size > 0) {
      this.scheduleDrain(this.now())
    }
  }

  dispose(): void {
    if (this.drainTimer !== null) {
      ;(this.deps.cancel ?? clearTimeout)(this.drainTimer as ReturnType<typeof setTimeout>)
      this.drainTimer = null
    }
    if (this.pruneTimer !== null) {
      ;(this.deps.cancel ?? clearTimeout)(this.pruneTimer as ReturnType<typeof setTimeout>)
      this.pruneTimer = null
    }
    this.queue.clear()
    this.failed.clear()
    this.requestedAtByPaneKey.clear()
  }

  private fire(request: SleepingPaneWakeRequest, now: number): boolean {
    this.lastAttemptAt = now
    try {
      if (!this.deps.wake(request)) {
        return false
      }
    } catch {
      return false
    }
    this.requestedAtByPaneKey.set(request.paneKey, now)
    this.scheduleSuppressionPrune(now)
    return true
  }

  private scheduleDrain(now: number): void {
    if (this.drainTimer !== null) {
      return
    }
    const delay = Math.max(0, this.lastAttemptAt + SLEEPING_PANE_WAKE_SPACING_MS - now)
    const timer = (this.deps.schedule ?? setTimeout)(() => {
      this.drainTimer = null
      this.drain()
    }, delay)
    this.drainTimer = timer
    if (typeof timer !== 'number') {
      timer.unref?.()
    }
  }

  private drain(): void {
    const now = this.now()
    this.pruneSuppressions(now)
    const next = this.queue.entries().next()
    if (next.done) {
      return
    }
    const [paneKey, queued] = next.value
    this.queue.delete(paneKey)
    if (!this.fire(queued.request, now)) {
      if (queued.failures === 0) {
        this.queue.set(paneKey, { request: queued.request, failures: 1 })
      } else {
        // Do not poll forever while no renderer exists. A later graph-ready
        // edge or message arrival calls retryPending/request respectively.
        this.failed.set(paneKey, queued.request)
      }
    }
    if (this.queue.size > 0) {
      this.scheduleDrain(now)
    }
  }

  private pruneSuppressions(now: number): void {
    for (const [paneKey, requestedAt] of this.requestedAtByPaneKey) {
      if (now - requestedAt >= SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS) {
        this.requestedAtByPaneKey.delete(paneKey)
      }
    }
  }

  private scheduleSuppressionPrune(now: number): void {
    if (this.pruneTimer !== null) {
      return
    }
    const firstRequestedAt = this.requestedAtByPaneKey.values().next().value
    if (firstRequestedAt === undefined) {
      return
    }
    const delay = Math.max(0, firstRequestedAt + SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS - now)
    const timer = (this.deps.schedule ?? setTimeout)(() => {
      this.pruneTimer = null
      const currentNow = this.now()
      this.pruneSuppressions(currentNow)
      if (this.requestedAtByPaneKey.size > 0) {
        this.scheduleSuppressionPrune(currentNow)
      }
    }, delay)
    this.pruneTimer = timer
    if (typeof timer !== 'number') {
      timer.unref?.()
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
