import type { PRRefreshQueueEntry } from './pr-refresh-queue'

const BACKGROUND_BUDGET_WINDOW_MS = 5 * 60_000
const MIN_BACKGROUND_SPACING_MS = 10_000
const BACKGROUND_BUDGET_MAX = 20
const ACTIVE_BURST_WINDOW_MS = 30_000
const ACTIVE_BURST_MAX = 3

export class PRRefreshPacing {
  private readonly backgroundStarts: number[] = []
  private readonly activeStartsByScope = new Map<string, number[]>()
  private lastBackgroundStartAt = 0

  clearActiveBurstWindow(windowId: number): void {
    const windowPrefix = `${windowId}::`
    for (const scope of Array.from(this.activeStartsByScope.keys())) {
      if (scope.startsWith(windowPrefix)) {
        this.activeStartsByScope.delete(scope)
      }
    }
  }

  noteBackgroundStart(): void {
    const now = Date.now()
    this.lastBackgroundStartAt = now
    this.backgroundStarts.push(now)
    this.pruneBackgroundStarts(now)
  }

  nextBudgetDelay(): number {
    const now = Date.now()
    this.pruneBackgroundStarts(now)
    const spacingDelay =
      this.lastBackgroundStartAt > 0
        ? Math.max(0, MIN_BACKGROUND_SPACING_MS - (now - this.lastBackgroundStartAt))
        : 0
    const windowDelay =
      this.backgroundStarts.length < BACKGROUND_BUDGET_MAX
        ? 0
        : Math.max(1_000, BACKGROUND_BUDGET_WINDOW_MS - (now - this.backgroundStarts[0]))
    return Math.max(spacingDelay, windowDelay)
  }

  activeOrder(a: PRRefreshQueueEntry, b: PRRefreshQueueEntry): number {
    if (a.reason !== 'active' || b.reason !== 'active') {
      return 0
    }
    if (this.activeBurstScope(a) !== this.activeBurstScope(b)) {
      return 0
    }
    return b.queuedAt - a.queuedAt
  }

  entryDelay(entry: PRRefreshQueueEntry): number {
    const activeDelay = entry.reason === 'active' ? this.nextActiveBurstDelay(entry) : 0
    if (activeDelay > 0) {
      return activeDelay
    }
    return entry.bypassBackgroundBudget !== true &&
      (entry.reason === 'visible' || entry.reason === 'swr')
      ? this.nextBudgetDelay()
      : 0
  }

  isActiveBurstDelayed(entry: PRRefreshQueueEntry): boolean {
    return entry.reason === 'active' && this.nextActiveBurstDelay(entry) > 0
  }

  noteActiveStart(entry: PRRefreshQueueEntry): void {
    const now = Date.now()
    const scope = this.activeBurstScope(entry)
    const activeStarts = this.pruneActiveStarts(scope, now)
    activeStarts.push(now)
    this.activeStartsByScope.set(scope, activeStarts)
  }

  private pruneBackgroundStarts(now: number): void {
    while (
      this.backgroundStarts.length > 0 &&
      now - this.backgroundStarts[0] > BACKGROUND_BUDGET_WINDOW_MS
    ) {
      this.backgroundStarts.shift()
    }
  }

  private activeBurstScope(entry: PRRefreshQueueEntry): string {
    const runtimeScope = entry.candidate.connectionId
      ? `ssh:${entry.candidate.connectionId}`
      : `local:${entry.candidate.localGitOptions?.wslDistro ?? 'host'}`
    return `${entry.windowId ?? 'global'}::${runtimeScope}`
  }

  private pruneActiveStarts(scope: string, now: number): number[] {
    const activeStarts = this.activeStartsByScope.get(scope) ?? []
    while (activeStarts.length > 0 && now - activeStarts[0] >= ACTIVE_BURST_WINDOW_MS) {
      activeStarts.shift()
    }
    if (activeStarts.length === 0) {
      this.activeStartsByScope.delete(scope)
    } else {
      this.activeStartsByScope.set(scope, activeStarts)
    }
    return activeStarts
  }

  private nextActiveBurstDelay(entry: PRRefreshQueueEntry): number {
    const now = Date.now()
    const activeStarts = this.pruneActiveStarts(this.activeBurstScope(entry), now)
    if (activeStarts.length < ACTIVE_BURST_MAX) {
      return 0
    }
    return Math.max(1, ACTIVE_BURST_WINDOW_MS - (now - activeStarts[0]))
  }
}
