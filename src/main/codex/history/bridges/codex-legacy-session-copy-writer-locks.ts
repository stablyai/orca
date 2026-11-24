import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * A Codex writing the copy runs with the copy's home as CODEX_HOME and holds the thread's lock
 * there; a home with no lock folder has had no Codex that keeps them, so nothing proves it idle.
 */
export async function isCopyIdle(args: {
  managedHome: string
  relativePath: string
}): Promise<boolean> {
  if (!(await keepsThreadLocks(args.managedHome))) {
    return false
  }
  const locks = join(args.managedHome, 'thread-writer-locks')
  const ids = threadIdsOf(args.relativePath)
  if (ids.length === 0) {
    return false
  }
  for (const id of ids) {
    try {
      await lstat(join(locks, `${id}.lock`))
      return false
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return false
      }
    }
  }
  return true
}

export async function keepsThreadLocks(home: string): Promise<boolean> {
  // A shared-history home links this folder into the store, so follow the link.
  return (await stat(join(home, 'thread-writer-locks')).catch(() => null))?.isDirectory() === true
}

/** A reverted thread's name carries its thread id and its rollout id: either can be the lock's. */
export function threadIdsOf(relativePath: string): string[] {
  return basename(relativePath).toLowerCase().match(UUID_PATTERN) ?? []
}

/** Drops a folder that resolves to one listed before it, keeping the first in its place. */
export async function distinctFolders(folders: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const folder of folders) {
    const resolved = await realpath(folder).catch(() => folder)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      kept.push(folder)
    }
  }
  return kept
}
