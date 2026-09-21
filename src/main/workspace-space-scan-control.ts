import type { WorkspaceSpaceScanStatus } from '../shared/workspace-space-types'
import { WorkspaceSpaceScanCapacityError } from '../shared/workspace-space-scan-budget'

export type AsyncLimiter = <T>(task: () => Promise<T>) => Promise<T>

export class WorkspaceSpaceScanCancelledError extends Error {
  constructor() {
    super('Workspace space scan cancelled')
    this.name = 'WorkspaceSpaceScanCancelledError'
  }
}

export function throwIfWorkspaceSpaceScanAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceSpaceScanCancelledError()
  }
}

export function isWorkspaceSpaceAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
  )
}

export function isWorkspaceSpaceRelayMethodMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === -32601
  )
}

export function classifyWorkspaceSpaceError(error: unknown): {
  status: Exclude<WorkspaceSpaceScanStatus, 'ok'>
  message: string
} {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof WorkspaceSpaceScanCapacityError) {
    return { status: 'unavailable', message }
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { status: 'missing', message }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { status: 'permission-denied', message }
  }
  return { status: 'error', message }
}

export function createWorkspaceSpaceScanLimiter(
  maxConcurrent: number,
  signal?: AbortSignal
): AsyncLimiter {
  let active = 0
  const queue: { resolve: () => void; reject: (error: Error) => void }[] = []

  const acquire = async (): Promise<void> => {
    throwIfWorkspaceSpaceScanAborted(signal)
    if (active < maxConcurrent) {
      active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | null = null
      const waiter = {
        resolve: () => {
          if (onAbort) {
            signal?.removeEventListener('abort', onAbort)
          }
          resolve()
        },
        reject
      }
      onAbort = () => {
        const index = queue.indexOf(waiter)
        if (index !== -1) {
          queue.splice(index, 1)
        }
        reject(new WorkspaceSpaceScanCancelledError())
      }
      queue.push(waiter)
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
        }
      }
    })
    throwIfWorkspaceSpaceScanAborted(signal)
    active += 1
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      active -= 1
      queue.shift()?.resolve()
    }
  }
}
