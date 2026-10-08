import { PluginDevWatcher } from './plugin-dev-watcher'

/** Starts and stops lifecycle maintenance as the feature flag and dev paths change. */
export class PluginServiceHousekeeping {
  private readonly devWatcher = new PluginDevWatcher()
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private watchedPathsKey: string | null = null
  private retryRefresh: (() => void) | null = null
  private bindingCheck: Promise<boolean | null> | null = null

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
    this.retryRefresh = options.refresh
    if (!this.reapTimer) {
      this.reapTimer = setInterval(() => {
        options.reapIdle()
        this.checkBindings()
      }, 60_000)
      this.reapTimer.unref?.()
    }
    const pathsKey = JSON.stringify(options.devPaths)
    if (pathsKey !== this.watchedPathsKey) {
      this.bindingCheck = null
      this.watchedPathsKey = pathsKey
      this.devWatcher.start(options.devPaths, options.refresh, (retry = true) => {
        // Retry failed registration even when the configured paths are unchanged.
        if (retry) {
          this.watchedPathsKey = null
        }
      })
    }
  }

  dispose(): void {
    this.stop()
  }

  private checkBindings(): void {
    if (this.bindingCheck) {
      return
    }
    const check = this.devWatcher.checkRootBindings()
    this.bindingCheck = check
    void check.then((changed) => {
      if (this.bindingCheck !== check) {
        return
      }
      this.bindingCheck = null
      if (changed === null) {
        return
      }
      if (changed) {
        this.watchedPathsKey = null
      }
      if (this.watchedPathsKey === null) {
        this.retryRefresh?.()
      }
    })
  }

  private stop(): void {
    this.bindingCheck = null
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    this.devWatcher.dispose()
    this.watchedPathsKey = null
    this.retryRefresh = null
  }
}
