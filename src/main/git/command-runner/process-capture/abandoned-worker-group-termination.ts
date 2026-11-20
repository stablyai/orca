import type { ChildProcess } from 'node:child_process'
import {
  forceTerminateProcessTree,
  posixProcessGroupQuiet
} from '@orca/process-host/process-tree-termination'
import type { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'

const ABANDONED_GROUP_FIRST_RETRY_MS = 1_000
const ABANDONED_GROUP_ATTEMPTS = 5
const ABANDONED_GROUP_SLOW_CHECK_MS = 60_000

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
  // A write's fence waits for proof; past the bursts, one table read a minute keeps main's cost flat.
  const checkSlowly = (pid: number): void => {
    setTimeout(() => {
      void posixProcessGroupQuiet(pid)
        .catch(() => false)
        .then((quiet) => (quiet ? reportEnded() : checkSlowly(pid)))
    }, ABANDONED_GROUP_SLOW_CHECK_MS).unref?.()
  }
  const attempt = (retryMs: number, left: number): void => {
    void forceTerminateProcessTree(group)
      .catch(() => false)
      .then((ended) => {
        if (ended) {
          reportEnded()
        } else if (left > 1) {
          setTimeout(() => attempt(retryMs * 2, left - 1), retryMs).unref?.()
        } else if (!lifetimeEndsOnLoss && child.pid) {
          checkSlowly(child.pid)
        }
      })
  }
  attempt(ABANDONED_GROUP_FIRST_RETRY_MS, ABANDONED_GROUP_ATTEMPTS)
  if (lifetimeEndsOnLoss) {
    onTerminated()
  }
}
