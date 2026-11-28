import { WatcherProcessSupervisor } from './supervision/parcel-watcher-process-supervisor'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import { RuntimeWatcherProcessPool } from './runtime-pool/runtime-watcher-process-pool'

let sharedDeliveryStallListener: ((stalled: boolean) => void) | null = null
// Other callers (e.g. git common-dir watches) can start the shared child, and a stall, before the
// local worktree watchers load and register; remember the state so a late listener starts in sync.
let sharedDeliveryStalled = false
const sharedWatcherProcessSupervisor = new WatcherProcessSupervisor({
  onDeliveryStallChange: (stalled) => {
    sharedDeliveryStalled = stalled
    sharedDeliveryStallListener?.(stalled)
  }
})
// Healthy roots share a child; quarantine adds isolation only after faults to limit RSS.
const runtimeWatcherProcessPool = new RuntimeWatcherProcessPool()

export function createWatcherProcessSupervisor(): WatcherProcessSupervisor {
  return new WatcherProcessSupervisor()
}

/** Local worktree watchers share one child; its OS event stalls pause auto-reload for all of them. */
export function setSharedWatcherDeliveryStallListener(
  listener: ((stalled: boolean) => void) | null
): void {
  sharedDeliveryStallListener = listener
  if (listener && sharedDeliveryStalled) {
    listener(true)
  }
}

export function subscribeViaWatcherProcess(
  dir: string,
  callback: WatcherProcessCallback,
  opts: WatcherProcessSubscribeOptions,
  hooks: WatcherProcessHooks = {}
): Promise<WatcherProcessSubscription> {
  return sharedWatcherProcessSupervisor.subscribe(dir, callback, opts, hooks)
}

export function subscribeViaRuntimeWatcherProcess(
  dir: string,
  callback: WatcherProcessCallback,
  opts: WatcherProcessSubscribeOptions,
  hooks: WatcherProcessHooks = {}
): Promise<WatcherProcessSubscription> {
  return runtimeWatcherProcessPool.subscribe(dir, callback, opts, hooks)
}

export function disposeWatcherProcess(): void {
  // Vitest reuses this singleton; production shutdown must reject later subscriptions.
  if (process.env.VITEST) {
    sharedWatcherProcessSupervisor.resetForTest()
    runtimeWatcherProcessPool.resetForTest()
  } else {
    sharedWatcherProcessSupervisor.dispose()
    runtimeWatcherProcessPool.dispose()
  }
}

export async function disposeWatcherProcessAndWait(): Promise<void> {
  const results = await Promise.allSettled([
    sharedWatcherProcessSupervisor.disposeAndWait(),
    runtimeWatcherProcessPool.disposeAndWait()
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'watcher_process_shutdown_incomplete')
  }
}

export function forgetRuntimeWatcherProcessRoot(rootPath: string): void {
  runtimeWatcherProcessPool.forgetRoot(rootPath)
}
