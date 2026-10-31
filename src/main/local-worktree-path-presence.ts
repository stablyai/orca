import { realpath, stat } from 'node:fs/promises'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { PrioritySemaphore } from '../shared/priority-semaphore'
import { abortSignalWithTimeout } from './lib/abort-signal-with-timeout'
import { waitForPromiseWithSignal, throwIfSignalAborted } from '../shared/abort-signal-reason'
import { assertWslUncPathRunning } from './wsl/wsl-unc-access-gate'
import { getErrorCode } from './git/worktree-operation-options'

// Share a concurrency bound across polling callers so slow mounts cannot multiply libuv work.
const LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY = 2
export const LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS = 2_000
const localWorktreePathProbeSemaphore = new PrioritySemaphore(LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY)

type PathObservationOptions = {
  signal?: AbortSignal
  wslDistro?: string
  isCurrent?: () => boolean
}
export type LocalWorktreeDirectoryState = 'directory' | 'missing' | 'unknown'
// A logical timeout never frees capacity still held by an actual filesystem operation.
async function observePath<T>(
  path: string,
  options: PathObservationOptions,
  read: () => Promise<T>
): Promise<T> {
  const signal = abortSignalWithTimeout(options.signal, LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
  const current = (): void => {
    throwIfSignalAborted(signal)
    if (options.isCurrent?.() === false) {
      throw new Error('Worktree observation superseded')
    }
  }
  current()
  const release = await localWorktreePathProbeSemaphore.acquire(0, signal)
  let pending: Promise<T>
  try {
    current()
    await assertWslUncPathRunning(path, options.wslDistro)
    current()
    pending = read().finally(release)
  } catch (error) {
    release()
    throw error
  }
  const result = await waitForPromiseWithSignal(pending, signal)
  current()
  return result
}

/** Only an affirmative directory observation can establish location availability. */
export function inspectLocalWorktreeDirectory(
  path: string,
  options: PathObservationOptions = {}
): Promise<LocalWorktreeDirectoryState> {
  return observePath(path, options, async () => {
    try {
      return (await stat(path)).isDirectory() ? 'directory' : 'unknown'
    } catch (error) {
      return getErrorCode(error) === 'ENOENT' ? 'missing' : 'unknown'
    }
  })
}

/** Failure to resolve a physical path never establishes identity or absence. */
export function resolveLocalWorktreeRealpath(
  path: string,
  options: PathObservationOptions = {}
): Promise<string | null> {
  return observePath(path, options, () => realpath(path).catch(() => null))
}

async function probeLocalWorktreePath(pathValue: string, signal: AbortSignal): Promise<boolean> {
  let release: () => void
  try {
    release = await localWorktreePathProbeSemaphore.acquire(0, signal)
  } catch {
    return true
  }
  if (signal.aborted) {
    release()
    return true
  }
  const presence = stat(pathValue)
    .then(
      () => true,
      (error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        return code !== 'ENOENT' && code !== 'ENOTDIR'
      }
    )
    .finally(release)
  if (signal.aborted) {
    return true
  }
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(true)
    signal.addEventListener('abort', onAbort, { once: true })
    void presence.then(finish)
  })
}

/** A non-absence filesystem error cannot prove a native-local worktree disappeared. */
export function localWorktreePathExistsOrIsUnverifiable(
  pathValue: string,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  return probeLocalWorktreePath(
    pathValue,
    abortSignalWithTimeout(options.signal, LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
  )
}

export async function localWorktreePathsExistOrAreUnverifiable(
  pathValues: readonly string[],
  options: { signal?: AbortSignal } = {}
): Promise<ReadonlyMap<string, boolean>> {
  const uniquePaths = [...new Set(pathValues)]
  if (uniquePaths.length === 0) {
    return new Map()
  }
  const signal = abortSignalWithTimeout(options.signal, LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
  const results = await mapWithConcurrency(
    uniquePaths,
    LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY,
    async (pathValue) => [pathValue, await probeLocalWorktreePath(pathValue, signal)] as const
  )
  return new Map(results)
}
