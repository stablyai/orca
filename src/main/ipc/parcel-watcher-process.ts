// Host API for crash-isolated @parcel/watcher children. Desktop uses one
// supervisor; runtime roots use a bounded pool with independent crash fuses.
import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import { RuntimeWatcherProcessPool } from './runtime-watcher-process-pool'

export type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
export type {
  WatcherProcessDeliveryOptions,
  WatcherProcessEvent,
  WatcherProcessSubscribeOptions
} from './parcel-watcher-process-protocol'

const sharedWatcherProcessSupervisor = new WatcherProcessSupervisor()
// Why: the canary pauses during legitimate crawls, so production callers need
// a separate liveness fuse once a child reports that it owns native setup.
export const WATCHER_PROCESS_SUBSCRIBE_TIMEOUT_MS = 60_000
// Why: healthy roots share one child; only fault quarantine scales to four,
// containing a failed shard without paying that RSS cost during normal use.
const runtimeWatcherProcessPool = new RuntimeWatcherProcessPool()

export function createWatcherProcessSupervisor(): WatcherProcessSupervisor {
  return new WatcherProcessSupervisor()
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

/** Kill shared desktop and runtime watcher children at app/runtime shutdown. */
export function disposeWatcherProcess(): void {
  // Why: Vitest reuses this module singleton after closeAllWatchers(), while
  // production shutdown must remain final and reject any later subscription.
  if (process.env.VITEST) {
    sharedWatcherProcessSupervisor.resetForTest()
    runtimeWatcherProcessPool.resetForTest()
  } else {
    sharedWatcherProcessSupervisor.dispose()
    // Why: the runtime pool owns independent children that otherwise outlive a
    // shutdown sequence that does not immediately exit the main process.
    runtimeWatcherProcessPool.dispose()
  }
}

export function resetWatcherProcessForTest(): void {
  sharedWatcherProcessSupervisor.resetForTest()
}

export function resetRuntimeWatcherProcessForTest(): void {
  runtimeWatcherProcessPool.resetForTest()
}

export function forgetRuntimeWatcherProcessRoot(rootPath: string): void {
  runtimeWatcherProcessPool.forgetRoot(rootPath)
}
