import { stat } from 'node:fs/promises'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { PrioritySemaphore } from '../shared/priority-semaphore'

// Why: share one bound across polling callers so slow mounts cannot multiply libuv work.
const LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY = 2
export const LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS = 2_000
const localWorktreePathProbeSemaphore = new PrioritySemaphore(LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY)

function probeDeadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
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
  return probeLocalWorktreePath(pathValue, probeDeadline(options.signal))
}

export async function localWorktreePathsExistOrAreUnverifiable(
  pathValues: readonly string[],
  options: { signal?: AbortSignal } = {}
): Promise<ReadonlyMap<string, boolean>> {
  const uniquePaths = [...new Set(pathValues)]
  if (uniquePaths.length === 0) {
    return new Map()
  }
  const signal = probeDeadline(options.signal)
  const results = await mapWithConcurrency(
    uniquePaths,
    LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY,
    async (pathValue) => [pathValue, await probeLocalWorktreePath(pathValue, signal)] as const
  )
  return new Map(results)
}
