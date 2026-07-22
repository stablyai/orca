type PollState = {
  visible: boolean
  foreground: boolean
  polling: boolean
}

type RefreshResult = boolean | undefined

export class DictationSetupPollController {
  private state: PollState = { visible: false, foreground: false, polling: false }
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private immediateRefreshPending = false
  private refreshWaiters: Array<() => void> = []
  private disposed = false
  // Why: an explicit setPolling is a newer lifecycle intent than a read that was already on the wire.
  // Bumped on every setPolling so an in-flight refresh resolving after an explicit stop/start can be
  // fenced out instead of clobbering that intent (e.g. a late `true` resurrecting a just-stopped poll).
  private pollingRevision = 0

  constructor(
    private readonly refresh: () => Promise<RefreshResult>,
    private readonly intervalMs: number
  ) {}

  setVisible(visible: boolean): void {
    this.update({ visible })
  }

  setForeground(foreground: boolean): void {
    this.update({ foreground })
  }

  setPolling(polling: boolean): void {
    this.pollingRevision += 1
    this.update({ polling })
  }

  refreshNow(): Promise<void> {
    if (this.disposed || !this.isEligible()) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.refreshWaiters.push(resolve)
      this.requestRefresh(true)
    })
  }

  dispose(): void {
    this.disposed = true
    this.immediateRefreshPending = false
    this.clearTimer()
    this.resolveRefreshWaiters()
  }

  private update(next: Partial<PollState>): void {
    if (this.disposed) {
      return
    }
    const wasEligible = this.isEligible()
    const wasPolling = this.state.polling
    this.state = { ...this.state, ...next }

    if (!this.isEligible()) {
      this.immediateRefreshPending = false
      this.clearTimer()
      return
    }
    if (!wasEligible) {
      this.requestRefresh(true)
      return
    }
    if (!this.state.polling) {
      this.clearTimer()
      return
    }
    if (!wasPolling) {
      this.scheduleRefresh()
    }
  }

  private isEligible(): boolean {
    return this.state.visible && this.state.foreground
  }

  private requestRefresh(immediate: boolean): void {
    if (this.inFlight) {
      this.immediateRefreshPending ||= immediate
      return
    }
    this.clearTimer()
    this.inFlight = true
    void this.runRefresh()
  }

  private async runRefresh(): Promise<void> {
    // Snapshot the lifecycle intent this read is answering; an explicit setPolling during the read makes
    // its result stale.
    const revisionAtStart = this.pollingRevision
    let shouldContinue: RefreshResult
    try {
      shouldContinue = await this.refresh()
    } catch {
      // A transient read failure preserves the current lifecycle for a later retry.
      shouldContinue = undefined
    } finally {
      this.inFlight = false
    }

    // Fence: only let the read drive polling if no explicit setPolling superseded it mid-flight, so a
    // late `true` can't resurrect a poll the caller just stopped (nor a late `false` cancel a restart).
    if (shouldContinue !== undefined && this.pollingRevision === revisionAtStart) {
      this.state.polling = shouldContinue
    }
    if (this.disposed || !this.isEligible()) {
      this.resolveRefreshWaiters()
      return
    }
    if (this.immediateRefreshPending) {
      this.immediateRefreshPending = false
      this.requestRefresh(true)
      return
    }
    this.resolveRefreshWaiters()
    if (this.state.polling) {
      this.scheduleRefresh()
    }
  }

  private scheduleRefresh(): void {
    if (this.timer !== null || this.inFlight || !this.isEligible() || !this.state.polling) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.requestRefresh(false)
    }, this.intervalMs)
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private resolveRefreshWaiters(): void {
    const waiters = this.refreshWaiters.splice(0)
    for (const resolve of waiters) {
      resolve()
    }
  }
}
