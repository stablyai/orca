import { join } from 'node:path'
import { RuntimeWatcherProcessPool } from '../main/ipc/runtime-watcher-process-pool'
import { WatcherProcessSupervisor } from '../main/ipc/parcel-watcher-process-supervisor'

export type RelayWatcherProcessPool = Pick<
  RuntimeWatcherProcessPool,
  'dispose' | 'forgetRoot' | 'subscribe'
>

export function getRelayWatcherProcessEntryPath(): string {
  return join(__dirname, 'relay-watcher.js')
}

export function createRelayWatcherProcessPool(
  entryPath = getRelayWatcherProcessEntryPath()
): RelayWatcherProcessPool {
  return new RuntimeWatcherProcessPool({
    // Why: one SSH workspace normally installs three roots, and each remote
    // watcher child carries substantial Node/native-addon process overhead.
    maxSharedSupervisors: 1,
    createSupervisor: () =>
      new WatcherProcessSupervisor({
        entryPath,
        // Why: a leaked VITEST environment must never move the native addon
        // back into the relay when its crash-isolation child is missing.
        useInProcessVitestFallback: false
      })
  })
}
