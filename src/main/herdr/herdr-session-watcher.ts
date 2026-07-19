import type {
  HerdrEventSubscription,
  HerdrRuntimeError,
  HerdrSessionSnapshot
} from './herdr-runtime-contract'

export class HerdrSessionWatcher {
  private readonly eventSubscriptions = new Map<
    string,
    { cursor: number; subscription: HerdrEventSubscription }
  >()
  private readonly refreshes = new Map<string, Promise<void>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(
    private readonly subscribe: (
      sessionName: string,
      afterSequence: number
    ) => HerdrEventSubscription | null,
    private readonly snapshot: (sessionName: string) => Promise<HerdrSessionSnapshot>,
    private readonly acceptSnapshot: (sessionName: string, snapshot: HerdrSessionSnapshot) => void
  ) {}

  watch(sessionName: string, afterSequence: number): void {
    if (this.disposed || this.eventSubscriptions.has(sessionName)) {
      return
    }
    const subscription = this.subscribe(sessionName, afterSequence)
    if (!subscription) {
      return
    }
    const watcher = { cursor: afterSequence, subscription }
    this.eventSubscriptions.set(sessionName, watcher)
    subscription.onEvent((event) => {
      const current = this.eventSubscriptions.get(sessionName)
      if (current !== watcher || event.sequence <= current.cursor) {
        return
      }
      if (event.sequence !== current.cursor + 1) {
        this.restartFromSnapshot(sessionName)
        return
      }
      current.cursor = event.sequence
      this.refreshSnapshot(sessionName)
    })
    subscription.onError((error: HerdrRuntimeError) => {
      if (this.eventSubscriptions.get(sessionName) !== watcher) {
        return
      }
      if (error.code === 'stale_cursor' || error.code === 'transport_error') {
        this.restartFromSnapshot(sessionName)
      }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const watcher of this.eventSubscriptions.values()) {
      watcher.subscription.release()
    }
    this.eventSubscriptions.clear()
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
  }

  private refreshSnapshot(sessionName: string): void {
    if (this.refreshes.has(sessionName)) {
      return
    }
    const refresh = this.snapshot(sessionName)
      .then((snapshot) => this.acceptSnapshot(sessionName, snapshot))
      .catch(() => this.restartFromSnapshot(sessionName))
      .finally(() => this.refreshes.delete(sessionName))
    this.refreshes.set(sessionName, refresh)
  }

  private restartFromSnapshot(sessionName: string): void {
    if (this.disposed) {
      return
    }
    const current = this.eventSubscriptions.get(sessionName)
    current?.subscription.release()
    this.eventSubscriptions.delete(sessionName)
    void this.snapshot(sessionName)
      .then((snapshot) => {
        this.acceptSnapshot(sessionName, snapshot)
        this.watch(sessionName, snapshot.graph_revision)
      })
      .catch(() => {
        if (this.disposed || this.retryTimers.has(sessionName)) {
          return
        }
        const timer = setTimeout(() => {
          this.retryTimers.delete(sessionName)
          this.restartFromSnapshot(sessionName)
        }, 1_000)
        this.retryTimers.set(sessionName, timer)
      })
  }
}
