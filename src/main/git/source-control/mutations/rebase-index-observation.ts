import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath
} from '../../../../shared/git/metadata/git-metadata-path'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  gitOptionsForWorktree,
  type GitRuntimeOptions
} from '../../command-runner/git-runtime-options'

// Bounded: one entry per paused worktree is the expected size.
const MAX_CACHED_INDEXES = 64

type CachedIndex = {
  indexPath: string
  statKey: string | null
  hash: Promise<string | null> | null
}
const indexes = new Map<string, CachedIndex>()
// Worktrees whose paused step was reported empty: only they need status to observe the index.
const emptyStepWorktrees = new Set<string>()

function worktreeKey(worktreePath: string, options: GitRuntimeOptions): string {
  return `${options.wslDistro ?? ''}\0${path.resolve(worktreePath)}`
}

/** A Continue reported an empty step; status observes the index until the step moves on. */
export function noteRebaseEmptyStep(
  worktreePath: string,
  options: GitRuntimeOptions,
  empty: boolean
): void {
  const key = worktreeKey(worktreePath, options)
  if (empty) {
    emptyStepWorktrees.add(key)
  } else {
    emptyStepWorktrees.delete(key)
  }
}

/** Only an empty step's reader needs the index from status; every other paused status skips it. */
export function statusNeedsRebaseIndexObservation(
  worktreePath: string,
  options: GitRuntimeOptions,
  rebasing: boolean
): boolean {
  if (!rebasing) {
    noteRebaseEmptyStep(worktreePath, options, false)
    return false
  }
  return emptyStepWorktrees.has(worktreeKey(worktreePath, options))
}

async function resolveIndexPath(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  const { stdout } = await gitExecFileAsync(
    ['rev-parse', '--git-path', 'index'],
    gitOptionsForWorktree(worktreePath, options)
  )
  const rawPath = stdout.replace(/\r?\n$/, '')
  if (!rawPath || /[\r\n]/.test(rawPath)) {
    return null
  }
  const hostWorktree = resolveWorktreeHostPath(worktreePath, options)
  return hostWorktree ? resolveGitMetadataPath(hostWorktree, rawPath, options) : null
}

async function hashFile(indexPath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(indexPath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * The index bytes identify staged content, including changes to an already-staged path. Git
 * replaces the index by rename, so an unchanged stat means unchanged bytes; only a changed stat
 * reads the file again, and concurrent readers of one index share that read.
 */
export async function readRebaseIndexObservation(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string | null> {
  const key = worktreeKey(worktreePath, options)
  try {
    let cached = indexes.get(key)
    if (!cached) {
      const indexPath = await resolveIndexPath(worktreePath, options)
      if (!indexPath) {
        return null
      }
      cached = { indexPath, statKey: null, hash: null }
      const oldest = indexes.keys().next()
      if (indexes.size >= MAX_CACHED_INDEXES && !oldest.done) {
        indexes.delete(oldest.value)
      }
      indexes.set(key, cached)
    }
    const info = await stat(cached.indexPath, { bigint: true })
    const statKey = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    if (cached.statKey !== statKey || !cached.hash) {
      cached.statKey = statKey
      const entry = cached
      entry.hash = hashFile(entry.indexPath).catch(() => {
        // A failed read never stands in for the bytes; the next caller reads again.
        if (entry.statKey === statKey) {
          entry.hash = null
        }
        return null
      })
    }
    const hash = await cached.hash
    // The file changed during the read: the bytes hashed may be either version.
    const after = await stat(cached.indexPath, { bigint: true })
    if (`${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== statKey) {
      return null
    }
    return hash
  } catch {
    // A moved or missing index resolves its path again next time.
    indexes.delete(key)
    return null
  }
}
