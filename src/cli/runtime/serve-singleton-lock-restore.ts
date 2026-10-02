import { link, lstat, readlink, symlink, unlink } from 'node:fs/promises'

export type MovedSingletonArtifact = { source: string; target: string; name: string }

export async function restoreExpectedSingletonLock(
  lock: MovedSingletonArtifact,
  expectedLockTarget: string,
  recoveryGuardTarget: string
): Promise<boolean> {
  try {
    if ((await readlink(lock.source)) !== recoveryGuardTarget) {
      return false
    }
    await unlink(lock.source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[serve] Could not remove guard for singleton rollback:', error)
      return false
    }
  }
  return restoreMovedSingletonLock(lock.source, lock.target, expectedLockTarget)
}

export async function restoreMovedSingletonLock(
  source: string,
  target: string,
  movedLockTarget: string | null
): Promise<boolean> {
  try {
    // Exclusive creation preserves a concurrent owner and our only backup.
    await (movedLockTarget ? symlink(movedLockTarget, source) : link(target, source))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn('[serve] Could not restore singleton lock; retaining backup:', error)
    }
    return false
  }
  await unlink(target).catch((error) => {
    console.warn('[serve] Could not remove restored singleton backup:', error)
  })
  return true
}

export async function restoreSingletonCompanions(
  entries: readonly MovedSingletonArtifact[]
): Promise<void> {
  for (const entry of entries.toReversed()) {
    try {
      // Exclusive creation never overwrites a companion installed by another owner.
      await link(entry.target, entry.source)
      await unlink(entry.target)
    } catch (error) {
      console.warn('[serve] Could not restore singleton companion; retaining backup:', error)
    }
  }
}

export async function removeRestoredSingletonBackups(
  entries: readonly MovedSingletonArtifact[]
): Promise<boolean> {
  for (const entry of entries) {
    try {
      const [source, backup] = await Promise.all([lstat(entry.source), lstat(entry.target)])
      if (source.dev === backup.dev && source.ino === backup.ino) {
        continue
      }
      if (
        !source.isSymbolicLink() ||
        !backup.isSymbolicLink() ||
        (await readlink(entry.source)) !== (await readlink(entry.target))
      ) {
        return false
      }
    } catch {
      return false
    }
  }
  // Restored duplicates are only directory entries; never remove their socket targets.
  await Promise.all(entries.map((entry) => unlink(entry.target)))
  return true
}
