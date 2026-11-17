import {
  isAbandonedWorkerChildError,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'

const WORKER_PID_WAIT_MS = 5_000

/** Keep a late spawn subscribed: killing the root before a tree walk would orphan descendants. */
export function runOnceWorkerReportsPid(
  child: WorkerThreadChildProcess,
  action: () => Promise<boolean>
): Promise<boolean> {
  if (child.abandoned) {
    return Promise.resolve(false)
  }
  if (child.pid) {
    return action()
  }
  // A close the worker reported before any PID means the process never started: nothing is left to stop.
  if (child.closed) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const settle = (result: boolean): void => {
      clearTimeout(timer)
      resolve(result)
    }
    const detach = (): void => {
      child.off('spawn', onSpawn)
      child.off('close', onClose)
      child.off('error', onError)
    }
    const onSpawn = (): void => {
      detach()
      clearTimeout(timer)
      try {
        void action().then(settle, () => settle(false))
      } catch {
        settle(false)
      }
    }
    const onClose = (): void => {
      detach()
      settle(true)
    }
    const onError = (error: Error): void => {
      if (isAbandonedWorkerChildError(error)) {
        detach()
        settle(false)
      }
    }
    const timer = setTimeout(() => settle(false), WORKER_PID_WAIT_MS)
    timer.unref?.()
    child.on('spawn', onSpawn)
    child.on('close', onClose)
    child.on('error', onError)
  })
}
