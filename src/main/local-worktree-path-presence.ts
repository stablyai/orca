import { stat } from 'node:fs/promises'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import { PrioritySemaphore } from '../shared/priority-semaphore'
import { abortSignalWithTimeout } from './lib/abort-signal-with-timeout'

// Share a concurrency bound across polling callers so slow mounts cannot multiply libuv work.
const LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY = 2
export const LOCAL_WORKTREE_PATH_PROBE_TIMEOUT_MS = 2_000
const localWorktreePathProbeSemaphore = new PrioritySemaphore(LOCAL_WORKTREE_PATH_PROBE_CONCURRENCY)

type LocalWorktreePathPresence = 'directory' | 'other' | 'missing' | 'unknown'

async function probeLocalWorktreePath(
  pathValue: string,
  signal: AbortSignal
): Promise<LocalWorktreePathPresence> {
  let release: () => void
  try {
    release = await localWorktreePathProbeSemaphore.acquire(0, signal)
  } catch {
    return 'unknown'
  }
  if (signal.aborted) {
    release()
    return 'unknown'
  }
  const presence = stat(pathValue)
    .then(
      (info) => (info.isDirectory() ? ('directory' as const) : ('other' as const)),
      (error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        return code === 'ENOENT' || code === 'ENOTDIR' ? ('missing' as const) : ('unknown' as const)
      }
    )
    .finally(release)
  if (signal.aborted) {
    return 'unknown'
  }
  return new Promise((resolve) => {
    const finish = (value: LocalWorktreePathPresence): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish('unknown')
    signal.addEventListener('abort', onAbort, { once: true })
    void presence.then(finish)
  })
}

/** A non-absence filesystem error cannot prove a native-local worktree disappeared. */
export function localWorktreePathExistsOrIsUnverifiable(
  pathValue: string,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  return localWorktreePathPresence(pathValue, options).then((presence) => presence !== 'missing')
}

export function localWorktreePathPresence(
  pathValue: string,
  options: { signal?: AbortSignal } = {}
): Promise<LocalWorktreePathPresence> {
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
    async (pathValue) =>
      [pathValue, (await probeLocalWorktreePath(pathValue, signal)) !== 'missing'] as const
  )
  return new Map(results)
}
