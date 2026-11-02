import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { toWindowsWslPath } from '../shared/wsl-paths'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'

type InFlightWorktreeCreate = { repoId: string; paths: string[] }

const inFlightCreates = new Set<InFlightWorktreeCreate>()
const claimedCreatePaths = new Set<string>()

export type WorktreeCreatePathClaim = {
  /** Synchronous, so the path check that calls it cannot interleave with another create's. */
  claim: (worktreePath: string) => boolean
  release: () => void
}

/** Concurrent creates can both find a path free before either adds it; the later one must take its next candidate. */
export function openWorktreeCreatePathClaim(): WorktreeCreatePathClaim {
  let held: string | null = null
  const release = (): void => {
    if (held !== null) {
      claimedCreatePaths.delete(held)
      held = null
    }
  }
  return {
    claim: (worktreePath) => {
      if (held !== null && areWorktreePathsEqual(held, worktreePath)) {
        return true
      }
      for (const claimed of claimedCreatePaths) {
        if (areWorktreePathsEqual(claimed, worktreePath)) {
          return false
        }
      }
      release()
      claimedCreatePaths.add(worktreePath)
      held = worktreePath
      return true
    },
    release
  }
}

// Git lists real paths even when creation uses a symlink and the leaf does not exist yet.
async function resolveCreatePathAlias(worktreePath: string): Promise<string> {
  let ancestor = worktreePath
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...missing)
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        return worktreePath
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) {
        return worktreePath
      }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

/** Hide untagged checkouts until metadata makes sidebar filters reliable. */
export async function holdInFlightWorktreeCreate(
  repoId: string,
  worktreePath: string,
  options: { wslDistro?: string } = {}
): Promise<() => void> {
  const hostPath =
    process.platform === 'win32' && options.wslDistro && worktreePath.startsWith('/')
      ? toWindowsWslPath(worktreePath, options.wslDistro)
      : worktreePath
  const entry: InFlightWorktreeCreate = {
    repoId,
    paths: [worktreePath, hostPath, await resolveCreatePathAlias(hostPath)]
  }
  inFlightCreates.add(entry)
  return () => {
    inFlightCreates.delete(entry)
  }
}

export function withoutInFlightWorktreeCreates<T extends { path: string }>(
  repoId: string,
  rows: T[]
): T[] {
  if (inFlightCreates.size === 0) {
    return rows
  }
  const held = [...inFlightCreates].filter((entry) => entry.repoId === repoId)
  if (held.length === 0) {
    return rows
  }
  return rows.filter(
    (row) =>
      !held.some((entry) => entry.paths.some((path) => areWorktreePathsEqual(row.path, path)))
  )
}
