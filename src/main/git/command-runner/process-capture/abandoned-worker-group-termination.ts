import type { ChildProcess } from 'node:child_process'
import {
  forceTerminateProcessTree,
  posixProcessGroupQuiet
} from '@orca/process-host/process-tree-termination'
import type { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'

const ABANDONED_GROUP_FIRST_CHECK_MS = 1_000
const ABANDONED_GROUP_MAX_CHECK_MS = 60 * 60_000

/** A dead worker can't stop or reap its owned POSIX group, so main ends it; the unreaped root keeps the group id reserved until its exit was reported. */
export function endAbandonedWorkerGroup(
  child: WorkerThreadChildProcess,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void,
  lifetimeEndsOnLoss: boolean
): void {
  onWorkerLost?.()
  const rootExited = child.exitCode !== null || child.signalCode !== null
  // An exited root not being stopped ends its lifetime as a normal close would; a stop still needs the group gone.
  if (child.ownedGroupTerminated || (rootExited && !child.ownedGroupStopping)) {
    onTerminated()
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the group kill reads only pid, exitCode, signalCode and kill, which the stand-in carries.
  const group = child as unknown as ChildProcess
  const reportEnded = (): void => {
    if (!lifetimeEndsOnLoss) {
      onTerminated()
    }
  }
  // SIGKILL is already pending after the first kill, so later checks are one table read each, backing off to hourly.
  const checkLater = (pid: number, delayMs: number): void => {
    setTimeout(() => {
      void posixProcessGroupQuiet(pid)
        .catch(() => false)
        .then((quiet) =>
          quiet
            ? reportEnded()
            : checkLater(pid, Math.min(delayMs * 2, ABANDONED_GROUP_MAX_CHECK_MS))
        )
    }, delayMs).unref?.()
  }
  void forceTerminateProcessTree(group)
    .catch(() => false)
    .then((ended) => {
      if (ended) {
        reportEnded()
      } else if (!lifetimeEndsOnLoss && child.pid) {
        checkLater(child.pid, ABANDONED_GROUP_FIRST_CHECK_MS)
      }
    })
  if (lifetimeEndsOnLoss) {
    onTerminated()
  }
}
