import { sessionSearchRequiresPolling } from './session-search-filesystem'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WatcherProcessSupervisor } from '../ipc/filesystem/watcher-process/parcel-watcher-process-supervisor'
import type { WatcherProcessSubscription } from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'
import type { WatcherProcessEvent } from '../ipc/filesystem/watcher-process/parcel-watcher-process-protocol'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
export type SessionSearchRootWatch = {
  identity: string
  subscription?: WatcherProcessSubscription
  failed: boolean
  events: Map<string, WatcherProcessEvent>
  reconcile: boolean
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
  watch(path: string, signal?: AbortSignal): Promise<SessionSearchRootWatch | undefined> {
    let probe = this.probes.get(path)
    if (!probe) {
      probe = this.probeWatch(path, signal).then((watch) => {
        if (!watch) {
          return undefined
        }
        const delivery = { ...watch }
        watch.events = new Map()
        watch.reconcile = false
        return delivery
      })
      this.probes.set(path, probe)
    }
    return probe
  }

  private async probeWatch(
    path: string,
    signal?: AbortSignal
  ): Promise<SessionSearchRootWatch | undefined> {
    let identity: string
    try {
      const stat = await wslGatedStat(path, 'scan', signal)
      if (!stat.isDirectory()) {
        return undefined
      }
      identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
    } catch {
      throwIfAiVaultScanCancelled(signal)
      return undefined
    }
    const previous = this.watches.get(path)
    if (previous && !previous.failed && previous.identity === identity) {
      return previous
    }
    await previous?.subscription?.unsubscribe().catch(() => undefined)
    const watch: SessionSearchRootWatch = {
      identity,
      failed: false,
      events: new Map(),
      reconcile: true
    }
    this.watches.set(path, watch)
    const fail = () => {
      watch.failed = true
      watch.reconcile = true
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
              break
            }
            watch.events.set(event.path, event)
          }
        },
        { mode: 'recursive' },
        {
          signal: this.owner.signal,
          onInterruption: fail,
          onOverflow: () => {
            watch.reconcile = true
          },
          onTerminalError: fail,
          delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 16_384 }
        }
      )
      if (this.owner.signal.aborted) {
        await watch.subscription.unsubscribe()
      }
    } catch {
      watch.failed = true
      throwIfAiVaultScanCancelled(this.owner.signal)
    }
    return watch
  }

  requiresPolling(path: string): Promise<boolean> {
    return sessionSearchRequiresPolling(path)
  }
}
