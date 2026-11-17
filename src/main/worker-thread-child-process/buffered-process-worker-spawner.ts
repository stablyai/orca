import type { BufferedProcessSpawn, ProcessSpec } from '@orca/process-host/process-spec'
import {
  canSpawnOnWorkerThread,
  isAbandonedWorkerChildError,
  isWorkerChildStdinWriteError,
  runOnceWorkerReportsPid,
  spawnProcessOnWorkerThread
} from './worker-thread-child-process'

export function spawnBufferedProcessOnWorker(spec: ProcessSpec): BufferedProcessSpawn | undefined {
  const stdio = spec.stdio
  if (
    process.platform !== 'win32' ||
    spec.detached ||
    spec.serialization !== undefined ||
    (stdio !== undefined &&
      stdio !== 'pipe' &&
      !(Array.isArray(stdio) && stdio.length === 3 && stdio.every((entry) => entry === 'pipe'))) ||
    'uid' in spec ||
    'gid' in spec ||
    'shell' in spec ||
    'argv0' in spec ||
    !canSpawnOnWorkerThread()
  ) {
    return undefined
  }
  const child = spawnProcessOnWorkerThread({
    program: spec.program,
    args: [...(spec.args ?? [])],
    cwd: spec.cwd,
    // Main can refresh PATH after the shared worker has started.
    env: spec.env ?? process.env,
    windowsVerbatimArguments: spec.windowsVerbatimArguments
  })
  return {
    child,
    withPid: (action) => runOnceWorkerReportsPid(child, action),
    isAbandonedError: isAbandonedWorkerChildError,
    isStdinWriteError: isWorkerChildStdinWriteError
  }
}
