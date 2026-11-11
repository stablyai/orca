import { sessionSearchRequiresPolling } from './session-search-filesystem'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WatcherProcessSupervisor } from '../ipc/filesystem/watcher-process/parcel-watcher-process-supervisor'
import type { WatcherProcessSubscription } from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import type { WatcherProcessEvent } from '../ipc/filesystem/watcher-process/parcel-watcher-process-protocol'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import { RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS } from '../../shared/file-watch/runtime-file-watch-limits'
export type SessionSearchRootWatch = {
  identity: string
  subscription?: WatcherProcessSubscription
  failed: boolean
  events: Map<string, WatcherProcessEvent>
  reconcile: boolean
  recovery: boolean
  attempts: number
  retryAt: number
}

export class SessionSearchRootWatchers {
  private readonly watches = new Map<string, SessionSearchRootWatch>()
  private readonly owner = new AbortController()
  private readonly supervisor: WatcherProcessSupervisor
  private probes = new Map<string, Promise<SessionSearchRootWatch | undefined>>()
  constructor(entryPath?: string) {
    this.supervisor = new WatcherProcessSupervisor({ entryPath })
  }
  begin(): void {
    this.probes = new Map()
  }
  async end(): Promise<void> {
    for (const [path, watch] of this.watches) {
      if (!this.probes.has(path)) {
        this.watches.delete(path)
        await watch.subscription?.unsubscribe()
      }
    }
  }
  close(): Promise<void> {
    this.owner.abort()
    this.watches.clear()
    return this.supervisor.disposeAndWait()
  }
  watch(
    path: string,
    signal?: AbortSignal,
    mode: 'recursive' | 'shallow' = 'recursive'
  ): Promise<SessionSearchRootWatch | undefined> {
    const key = `${mode}:${path}`
    let probe = this.probes.get(key)
    if (!probe) {
      probe = this.probeWatch(path, key, mode, signal).then((watch) => {
        if (!watch) {
          return undefined
        }
        const delivery = { ...watch }
        watch.events = new Map()
        watch.reconcile = false
        watch.recovery = false
        return delivery
      })
      this.probes.set(key, probe)
    }
    return probe
  }

  private async probeWatch(
    path: string,
    key: string,
    mode: 'recursive' | 'shallow',
    signal?: AbortSignal
  ): Promise<SessionSearchRootWatch | undefined> {
    const previous = this.watches.get(key)
    let identity: string
    try {
      const stat = await wslGatedStat(path, 'scan', signal)
      if (!stat.isDirectory()) {
        this.watches.delete(key)
        await previous?.subscription?.unsubscribe()
        return undefined
      }
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    } catch {
      throwIfAiVaultScanCancelled(signal)
      this.watches.delete(key)
      await previous?.subscription?.unsubscribe().catch(() => undefined)
      return undefined
    }
    if (
      previous &&
      previous.identity === identity &&
      (!previous.failed || Date.now() < previous.retryAt)
    ) {
      return previous
    }
    await previous?.subscription?.unsubscribe().catch(() => undefined)
    const watch: SessionSearchRootWatch = {
      identity,
      failed: false,
      events: new Map(),
      reconcile: true,
      recovery: !!previous,
      attempts: previous?.attempts ?? 0,
      retryAt: 0
    }
    this.watches.set(key, watch)
    const fail = () => {
      if (!watch.failed) {
        watch.retryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(watch.attempts++, 6))
      }
      watch.failed = true
      watch.reconcile = true
      watch.recovery = true
    }
    try {
      watch.subscription = await this.supervisor.subscribe(
        path,
        (error, events) => {
          if (this.owner.signal.aborted) {
            return
          }
          if (error) {
            fail()
          }
          for (const event of events) {
            if (watch.events.size >= 16_384) {
              watch.reconcile = true
              watch.recovery = true
              break
            }
            watch.events.set(event.path, event)
          }
        },
        { mode },
        {
          signal: this.owner.signal,
          subscribeTimeoutMs: RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS,
          onInterruption: () => {
            watch.reconcile = true
            watch.recovery = true
          },
          onOverflow: () => {
            watch.reconcile = true
            watch.recovery = true
          },
          onTerminalError: fail,
          delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 16_384 }
        }
      )
      if (this.owner.signal.aborted) {
        await watch.subscription.unsubscribe()
      } else if (!watch.failed) {
        watch.attempts = 0
      }
    } catch {
      fail()
      throwIfAiVaultScanCancelled(this.owner.signal)
    }
    return watch
  }

  requiresPolling(path: string): Promise<boolean> {
    return sessionSearchRequiresPolling(path)
  }
}
