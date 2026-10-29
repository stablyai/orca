import { spawnProcess } from '@orca/process-host'
import type { WorkerThreadChildSpec } from './worker-thread-child-process-protocol'

// Spawn in-process so direct-child probe suites retain their child_process/process-host mocks.
export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec) {
  return spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
}
