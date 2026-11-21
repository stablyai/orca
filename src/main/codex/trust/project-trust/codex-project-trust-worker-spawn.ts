import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../worker-threads/worker-thread-entry-path'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'

const WORKER_ENTRY_FILENAME = 'codex-project-trust-worker-entry.js'

export function spawnCodexProjectTrustWorker(): WorkerRequestTransport {
  // A missing entry fails the spawned worker, which the queue reports as unavailable.
  return spawnWorkerThread(
    resolveWorkerThreadEntryPath(currentWorkerEntryLayout(__dirname), WORKER_ENTRY_FILENAME),
    {
      name: 'orca-codex-project-trust',
      // Hook commands on Windows resolve a bundled binary from main's resources folder.
      workerData: { resourcesPath: 'resourcesPath' in process ? process.resourcesPath : undefined }
    }
  )
}
