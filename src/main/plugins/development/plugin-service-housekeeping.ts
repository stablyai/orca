import { resolve } from 'node:path'
import { PLUGIN_WORKER_REAP_INTERVAL_MS } from '../../../shared/plugins/workers/plugin-host-protocol'
import { PluginDevWatcher } from './plugin-dev-watcher'

type DevRootWatch = {
  watcher: PluginDevWatcher
  retry: 'maintenance' | 'refresh' | null
  bindingCheck: Promise<boolean | null> | null
}

export class PluginServiceHousekeeping {
  private readonly devWatchers = new Map<string, DevRootWatch>()
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private retryRefresh: (() => void) | null = null

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
      }, PLUGIN_WORKER_REAP_INTERVAL_MS)
      this.reapTimer.unref?.()
    }
    const roots = new Set(options.devPaths.map((path) => resolve(path)))
    for (const [root, watch] of this.devWatchers) {
      if (!roots.has(root)) {
        watch.watcher.dispose()
        this.devWatchers.delete(root)
      }
    }
    for (const root of roots) {
      let watch = this.devWatchers.get(root)
      if (!watch) {
        watch = { watcher: new PluginDevWatcher(), retry: null, bindingCheck: null }
        this.devWatchers.set(root, watch)
        this.startWatcher(root, watch)
      } else if (watch.retry === 'refresh') {
        this.startWatcher(root, watch)
      }
    }
  }

  dispose(): void {
    this.stop()
  }

  private checkBindings(): void {
    for (const [root, watch] of this.devWatchers) {
      if (watch.bindingCheck) {
        continue
      }
      const check = watch.watcher.checkRootBindings()
      watch.bindingCheck = check
      void check.then((changed) => {
        if (this.devWatchers.get(root) !== watch || watch.bindingCheck !== check) {
          return
        }
        watch.bindingCheck = null
        if (changed !== null && (changed || watch.retry)) {
          this.startWatcher(root, watch)
          // Why only on a new binding: a retry that subscribes refreshes itself, and one that keeps
          // failing (an unreachable share) must not rediscover every plugin each tick.
          if (changed) {
            this.retryRefresh?.()
          }
        }
      })
    }
  }

  private startWatcher(root: string, watch: DevRootWatch): void {
    watch.retry = null
    watch.bindingCheck = null
    watch.watcher.start(
      [root],
      () => this.retryRefresh?.(),
      (retry = true, recovery) => {
        if (retry) {
          // Terminal failures wait for maintenance; a known delivery gap recovers on refresh.
          watch.retry = recovery ? 'refresh' : (watch.retry ?? 'maintenance')
        }
      }
    )
  }

  private stop(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer)
      this.reapTimer = null
    }
    for (const watch of this.devWatchers.values()) {
      watch.watcher.dispose()
    }
    this.devWatchers.clear()
    this.retryRefresh = null
  }
}
