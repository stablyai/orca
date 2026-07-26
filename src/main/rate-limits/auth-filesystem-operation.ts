import { parseWslUncPath } from '../../shared/wsl-paths'

const MAX_CONCURRENT_WSL_AUTH_OPERATIONS = 2
export const MAX_QUEUED_WSL_AUTH_OPERATIONS = 128
export const MAX_AUTH_FILESYSTEM_OPERATION_WAITERS = 256
export const MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES = 64 * 1024
export const MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES = 128
export const MAX_AUTH_FILESYSTEM_REGISTRY_PATH_BYTES = 8 * 1024 * 1024
const activeWslOperationDistros = new Set<string>()
const queuedWslOperations: QueuedWslOperation<unknown>[] = []
let activeWslOperationCount = 0

export class AuthFilesystemOperationLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthFilesystemOperationLimitError'
  }
}

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
  if (queuedWslOperations.length >= MAX_QUEUED_WSL_AUTH_OPERATIONS) {
    return Promise.reject(
      new AuthFilesystemOperationLimitError(
        `Auth filesystem queue exceeds ${MAX_QUEUED_WSL_AUTH_OPERATIONS} operations`
      )
    )
  }
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

function rejectedAuthFilesystemOperation<T>(
  error: AuthFilesystemOperationLimitError
): SharedAuthFilesystemOperation<T> {
  const result = Promise.reject<T>(error)
  void result.catch(() => undefined)
  return {
    result,
    wait(signal) {
      return Promise.reject(signal.aborted ? getAbortReason(signal) : error)
    }
  }
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
  if (Buffer.byteLength(authPath, 'utf8') > MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES) {
    return rejectedAuthFilesystemOperation(
      new AuthFilesystemOperationLimitError(
        `Auth filesystem path exceeds ${MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES} bytes`
      )
    )
  }
  const neededController = new AbortController()
  let waiterCount = 0
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
        if (!settled && waiterCount === 0) {
          neededController.abort(getAbortReason(signal))
        }
        return Promise.reject(getAbortReason(signal))
      }

      if (settled) {
        return result
      }
      if (waiterCount >= MAX_AUTH_FILESYSTEM_OPERATION_WAITERS) {
        return Promise.reject(
          new AuthFilesystemOperationLimitError(
            `Auth filesystem operation exceeds ${MAX_AUTH_FILESYSTEM_OPERATION_WAITERS} waiters`
          )
        )
      }
      waiterCount += 1
      let onAbort: (() => void) | null = null
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(getAbortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      return Promise.race([result, aborted]).finally(() => {
        if (onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
        waiterCount -= 1
        if (!settled && waiterCount === 0) {
          neededController.abort(getAbortReason(signal))
        }
      })
    }
  }
}

export class AuthFilesystemOperationRegistry<T> {
  private readonly operations = new Map<string, SharedAuthFilesystemOperation<T>>()
  private retainedPathBytes = 0

  get size(): number {
    return this.operations.size
  }

  getOrCreate(
    authPath: string,
    operation: () => Promise<T>
  ): SharedAuthFilesystemOperation<T> | null {
    const pathBytes = Buffer.byteLength(authPath, 'utf8')
    if (pathBytes > MAX_AUTH_FILESYSTEM_OPERATION_PATH_BYTES) {
      return null
    }
    const existing = this.operations.get(authPath)
    if (existing) {
      return existing
    }
    if (
      this.operations.size >= MAX_AUTH_FILESYSTEM_REGISTRY_ENTRIES ||
      pathBytes > MAX_AUTH_FILESYSTEM_REGISTRY_PATH_BYTES - this.retainedPathBytes
    ) {
      return null
    }

    const shared = createAuthFilesystemOperation(authPath, operation)
    this.operations.set(authPath, shared)
    this.retainedPathBytes += pathBytes
    const clear = (): void => {
      if (this.operations.get(authPath) !== shared) {
        return
      }
      this.operations.delete(authPath)
      this.retainedPathBytes -= pathBytes
    }
    void shared.result.then(clear, clear)
    return shared
  }
}
