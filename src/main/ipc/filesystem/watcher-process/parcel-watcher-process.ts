import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'
import type { WatcherProcessSubscribeOptions } from './parcel-watcher-process-protocol'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks,
  WatcherProcessSubscription
} from './parcel-watcher-process-subscription'
import { RuntimeWatcherProcessPool } from '../../runtime-watcher-process-pool'

const sharedWatcherProcessSupervisor = new WatcherProcessSupervisor()
// Healthy roots share a child; quarantine adds isolation only after faults to limit RSS.
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

export function resetWatcherProcessForTest(): void {
  sharedWatcherProcessSupervisor.resetForTest()
}

export function resetRuntimeWatcherProcessForTest(): void {
  runtimeWatcherProcessPool.resetForTest()
}

export function forgetRuntimeWatcherProcessRoot(rootPath: string): void {
  runtimeWatcherProcessPool.forgetRoot(rootPath)
}
