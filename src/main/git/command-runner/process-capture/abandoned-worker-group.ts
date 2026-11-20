import type { ChildProcess } from 'node:child_process'
import { createPosixGroupTermination } from '@orca/process-host/posix-group-termination'
import type { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'

/**
 * An owned group whose worker died: capacity returns at once, and the group is stopped from main by
 * its pgid, as the worker's stop would have. Resolves once the group is gone or forced.
 */
export function endAbandonedGroup(
  child: WorkerThreadChildProcess,
  onWorkerLost?: () => void
): Promise<boolean> {
  onWorkerLost?.()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: group termination reads only pid and kill from the child.
  return createPosixGroupTermination(child as unknown as ChildProcess, () => {}).stop()
}
