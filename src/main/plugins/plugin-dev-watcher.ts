import {
  subscribeViaWatcherProcess,
  type WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'

type SubscribePluginPath = (
  path: string,
  onEvent: (error: Error | null) => void,
  onInterruption: () => void
) => Promise<WatcherProcessSubscription>

const subscribePluginPath: SubscribePluginPath = (path, onEvent, onInterruption) =>
  subscribeViaWatcherProcess(
    path,
    (error) => onEvent(error),
    {},
    {
      onInterruption,
      onTerminalError: onEvent
    }
  )

/** Owns debounced manifest/panel refresh watchers for mutable dev plugins. */
export class PluginDevWatcher {
  private readonly subscriptions: WatcherProcessSubscription[] = []
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly subscribePath: SubscribePluginPath = subscribePluginPath) {}

  start(devPaths: readonly string[], refresh: () => void, onWatcherError?: () => void): void {
    const generation = ++this.generation
    for (const devPath of devPaths) {
      let subscription: WatcherProcessSubscription | null = null
      let failedBeforeReady = false
      const fail = (): void => {
        if (generation !== this.generation) {
          return
        }
        failedBeforeReady = true
        if (subscription) {
          this.removeSubscription(subscription)
          void subscription.unsubscribe()
        }
        onWatcherError?.()
        this.scheduleRefresh(refresh)
      }
      void this.subscribePath(
        devPath,
        (error) => {
          if (error) {
            fail()
          } else if (generation === this.generation) {
            this.scheduleRefresh(refresh)
          }
        },
        () => {
          if (generation === this.generation) {
            // The watcher process recovered, but changes during the gap were
            // lost, so refresh the complete plugin projection once.
            this.scheduleRefresh(refresh)
          }
        }
      )
        .then((created) => {
          subscription = created
          if (generation !== this.generation || failedBeforeReady) {
            void created.unsubscribe()
            return
          }
          this.subscriptions.push(created)
        })
        .catch(() => {
          if (generation === this.generation) {
            onWatcherError?.()
          }
        })
    }
  }

  dispose(): void {
    this.generation += 1
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const subscription of this.subscriptions.splice(0)) {
      void subscription.unsubscribe()
    }
  }

  private removeSubscription(subscription: WatcherProcessSubscription): void {
    const index = this.subscriptions.indexOf(subscription)
    if (index >= 0) {
      this.subscriptions.splice(index, 1)
    }
  }

  private scheduleRefresh(refresh: () => void): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      refresh()
    }, 300)
  }
}
