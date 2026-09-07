import { PluginDevWatcher } from './plugin-dev-watcher'

/** Starts and stops lifecycle maintenance as the feature flag and dev paths change. */
export class PluginServiceHousekeeping {
  private readonly devWatcher = new PluginDevWatcher()
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private watchedPathsKey: string | null = null

  sync(options: {
    enabled: boolean
    devPaths: readonly string[]
    reapIdle: () => void
    refresh: () => void
  }): void {
    if (!options.enabled) {
      this.stop()
      return
    }
    if (!this.reapTimer) {
      this.reapTimer = setInterval(options.reapIdle, 60_000)
      this.reapTimer.unref?.()
    }
    const pathsKey = JSON.stringify(options.devPaths)
    if (pathsKey !== this.watchedPathsKey) {
      this.devWatcher.dispose()
      this.devWatcher.start(options.devPaths, options.refresh, () => {
        // The next refresh retries a failed watcher even when the configured
        // path list itself did not change.
        this.watchedPathsKey = null
      })
      this.watchedPathsKey = pathsKey
    }
  }

  dispose(): void {
    this.stop()
  }

  private stop(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    this.devWatcher.dispose()
    this.watchedPathsKey = null
  }
}
