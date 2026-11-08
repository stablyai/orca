import { access, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { BoundedMap } from '../../../shared/bounded-map'
import { delayUnlessAborted } from '../../../shared/abort-aware-delay'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveGitDir } from './resolve-git-dir'

const INDEX_LOCK_POLL_MS = 50
// Commits and staging release the lock well within this; a crashed Git can leave it forever.
const INDEX_LOCK_MAX_WAIT_MS = 1_000

/** Locks that outlived a full wait; later reads skip waiting until a different lock appears. */
const staleIndexLocks = new BoundedMap<string, string>({ maxEntries: 64 })

/** Defer status while Git rewrites the index (e.g. an agent mid-commit) so the read sees the settled result. */
export async function waitForIndexLockRelease(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro' | 'signal'>
): Promise<void> {
  try {
    // Linked worktrees keep their index, and its lock, under the gitdir their `.git` file names.
    const lockPath = path.join(await resolveGitDir(worktreePath, options), 'index.lock')
    if (!(await pathExists(lockPath))) {
      staleIndexLocks.delete(lockPath)
      return
    }
    const identity = await readLockIdentity(lockPath)
    if (identity !== null && staleIndexLocks.get(lockPath) === identity) {
      return
    }
    const deadline = performance.now() + INDEX_LOCK_MAX_WAIT_MS
    while (performance.now() < deadline) {
      if (options.signal?.aborted) {
        return
      }
      await (options.signal
        ? delayUnlessAborted(INDEX_LOCK_POLL_MS, options.signal)
        : new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_POLL_MS)))
      if (!(await pathExists(lockPath))) {
        return
      }
    }
    // Only the same lock surviving the whole wait is stale; a fresh one deserves its own wait.
    if (identity !== null && (await readLockIdentity(lockPath)) === identity) {
      staleIndexLocks.set(lockPath, identity)
    }
  } catch {
    // Deferral is an optimization; any probe failure reads status immediately.
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readLockIdentity(lockPath: string): Promise<string | null> {
  try {
    const stats = await stat(lockPath)
    return `${stats.mtimeMs}:${stats.ino}`
  } catch {
    return null
  }
}
