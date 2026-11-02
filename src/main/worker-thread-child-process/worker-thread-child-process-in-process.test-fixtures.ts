import { spawnProcess } from '@orca/process-host'
import type { WorkerThreadChildSpec } from './worker-thread-child-process-protocol'

// Mock target for suites that drive a probe's child directly: spawns in-process,
// so their own child_process/@orca/process-host mocks still apply.
export function spawnProcessOnWorkerThread(spec: WorkerThreadChildSpec) {
  return spawnProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
}
