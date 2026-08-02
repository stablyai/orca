import { parseWslUncPath } from '../../shared/wsl-paths'

const MAX_CONCURRENT_WSL_AUTH_OPERATIONS = 2
const activeWslOperationDistros = new Set<string>()
const queuedWslOperations: QueuedWslOperation<unknown>[] = []
let activeWslOperationCount = 0

type QueuedWslOperation<T> = {
  distroKey: string
  neededSignal: AbortSignal
  operation: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  onAbort: () => void
  state: 'queued' | 'running' | 'settled'
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Auth filesystem operation aborted')
}

function finishWslOperation<T>(task: QueuedWslOperation<T>, settle: () => void): void {
  if (task.state !== 'running') {
    return
  }
  task.state = 'settled'
  activeWslOperationCount -= 1
  activeWslOperationDistros.delete(task.distroKey)
  settle()
  pumpWslOperations()
}

function pumpWslOperations(): void {
  while (activeWslOperationCount < MAX_CONCURRENT_WSL_AUTH_OPERATIONS) {
    const nextIndex = queuedWslOperations.findIndex(
      (task) => !activeWslOperationDistros.has(task.distroKey)
    )
    if (nextIndex === -1) {
      return
    }
    const task = queuedWslOperations.splice(nextIndex, 1)[0]
    if (!task || task.state !== 'queued') {
      continue
    }
    task.neededSignal.removeEventListener('abort', task.onAbort)
    if (task.neededSignal.aborted) {
      task.state = 'settled'
      task.reject(getAbortReason(task.neededSignal))
      continue
    }
    task.state = 'running'
    activeWslOperationCount += 1
    activeWslOperationDistros.add(task.distroKey)
    void Promise.resolve()
      .then(() => {
        if (task.neededSignal.aborted) {
          throw getAbortReason(task.neededSignal)
        }
        return task.operation()
      })
      .then(
        (value) => finishWslOperation(task, () => task.resolve(value)),
        (error: unknown) => finishWslOperation(task, () => task.reject(error))
      )
  }
}

function scheduleWslAuthFilesystemOperation<T>(
  distroKey: string,
  neededSignal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const task: QueuedWslOperation<T> = {
      distroKey,
      neededSignal,
      operation,
      resolve,
      reject,
      state: 'queued',
      onAbort: () => {
        if (task.state !== 'queued') {
          return
        }
        task.state = 'settled'
        const index = queuedWslOperations.indexOf(task as QueuedWslOperation<unknown>)
        if (index !== -1) {
          queuedWslOperations.splice(index, 1)
        }
        reject(getAbortReason(neededSignal))
        pumpWslOperations()
      }
    }
    neededSignal.addEventListener('abort', task.onAbort, { once: true })
    queuedWslOperations.push(task as QueuedWslOperation<unknown>)
    queueMicrotask(pumpWslOperations)
  })
}

function scheduleAuthFilesystemOperation<T>(
  authPath: string,
  neededSignal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  const wslInfo = parseWslUncPath(authPath)
  if (!wslInfo) {
    return Promise.resolve().then(() => {
      if (neededSignal.aborted) {
        throw getAbortReason(neededSignal)
      }
      return operation()
    })
  }
  // Why: a few disconnected distros must not occupy libuv's entire default
  // filesystem pool. Distro serialization also folds wsl$/wsl.localhost and
  // case aliases without forcing healthy local auth reads through the queue.
  return scheduleWslAuthFilesystemOperation(
    wslInfo.distro.trim().toLowerCase(),
    neededSignal,
    operation
  )
}

export type SharedAuthFilesystemOperation<T> = {
  result: Promise<T>
  wait: (signal: AbortSignal) => Promise<T>
}

/**
 * Shares one raw operation with all callers for an auth path. WSL paths also
 * serialize by normalized distro because one stuck UNC request per account can
 * otherwise exhaust libuv's filesystem threadpool.
 */
export function createAuthFilesystemOperation<T>(
  authPath: string,
  operation: () => Promise<T>
): SharedAuthFilesystemOperation<T> {
  const neededController = new AbortController()
  const waiters = new Set<symbol>()
  let settled = false
  const result = scheduleAuthFilesystemOperation(authPath, neededController.signal, operation)
  const markSettled = (): void => {
    settled = true
  }
  void result.then(markSettled, markSettled)

  return {
    result,
    wait(signal) {
      if (signal.aborted) {
        if (!settled && waiters.size === 0) {
          neededController.abort(getAbortReason(signal))
        }
        return Promise.reject(getAbortReason(signal))
      }

      const waiter = Symbol('auth-filesystem-waiter')
      waiters.add(waiter)
      let onAbort: (() => void) | null = null
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(getAbortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      return Promise.race([result, aborted]).finally(() => {
        if (onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
        waiters.delete(waiter)
        if (!settled && waiters.size === 0) {
          neededController.abort(getAbortReason(signal))
        }
      })
    }
  }
}
