import { readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readSkillInstallLockOwner } from './skill-install-lock-owner'

const RELEASE_ENTRY_NAME = /^[a-f0-9-]{36}\.(?:owner|released)$/
const LOCK_DIRECTORY_RMDIR_IGNORED_CODES = new Set(['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY'])

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  })
}

async function removeDirectoryIfPresent(
  path: string,
  removeDirectory: (path: string) => Promise<void>
): Promise<void> {
  await removeDirectory(path).catch((error) => {
    if (!LOCK_DIRECTORY_RMDIR_IGNORED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error
    }
  })
}

export async function cleanupReleasedSkillInstallLock(
  path: string,
  token: string,
  removeDirectory: (path: string) => Promise<void> = rmdir
): Promise<void> {
  await unlinkIfPresent(join(path, `${token}.owner`))
  await unlinkIfPresent(join(path, `${token}.released`))
  await removeDirectoryIfPresent(path, removeDirectory)
}

export async function reclaimReleasedSkillInstallLock(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && RELEASE_ENTRY_NAME.test(entry.name))
      .map((entry) => unlinkIfPresent(join(path, entry.name)))
  )
  await rmdir(path).catch((error) => {
    if (!LOCK_DIRECTORY_RMDIR_IGNORED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error
    }
  })
}

async function readLockDirectoryEntries(path: string): Promise<string[]> {
  return await readdir(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  })
}

export async function releaseOwnedSkillInstallLock(input: {
  path: string
  token: string
  releasedPath: string
  removeDirectory?: (path: string) => Promise<void>
}): Promise<void> {
  const ownerEntry = `${input.token}.owner`
  const ownerPath = join(input.path, ownerEntry)
  if ((await readSkillInstallLockOwner(ownerPath))?.token !== input.token) {
    return
  }
  const entries = await readLockDirectoryEntries(input.path)
  if (!entries.includes(ownerEntry)) {
    return
  }
  if (entries.length > 1) {
    // Why: our own owner record is still published here, and no reclaim path touches a directory
    // whose owner is live, so this rename can only move the directory this release still owns.
    // Parking it keeps the canonical path usable despite entries this release must not delete.
    await rename(input.path, input.releasedPath)
    await cleanupReleasedSkillInstallLock(input.releasedPath, input.token, input.removeDirectory)
    return
  }
  await unlinkIfPresent(ownerPath)
  // Why: rmdir is the only take-away that carries its own ownership proof. Another active owner
  // publishes its owner record before the directory, while an ownerless published directory is
  // either unowned or kept nonempty by pollution, so a directory this release no longer owns stays.
  await removeDirectoryIfPresent(input.path, input.removeDirectory ?? rmdir)
}
