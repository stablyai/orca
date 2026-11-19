import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isPathInsideOrEqual } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

/** Orca's homes to delete in, and roots (the user's import folder) no deletion may reach. */
export type RolloutHomes = { homes: readonly string[]; protectedRoots: readonly string[] }

/** A protected root as seen from one rollout: where it really is, and the folders that hold it there. */
export type ProtectedRoot = { realPath: string; folderIds: ReadonlySet<string> }

/** Null when absent; a folder that can't be resolved for another reason throws. */
async function realpathUnlessAbsent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/** A folder's dev:ino, null when absent or when the filesystem gives no inode to tell folders apart. */
async function folderId(path: string): Promise<string | null> {
  try {
    const entry = await stat(path, { bigint: true })
    return entry.ino === 0n ? null : `${entry.dev}:${entry.ino}`
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/**
 * Each protected root for the rollout at `stem` (`YYYY/MM/DD/<name>`), unless it is the very folder
 * of a home Orca deletes from. A root that can't be read for a reason other than being gone throws.
 */
export async function resolveProtectedRoots(
  { homes, protectedRoots }: RolloutHomes,
  stem: string
): Promise<ProtectedRoot[]> {
  if (protectedRoots.length === 0) {
    return []
  }
  // A home that can't be read matches no root, so the root stays protected.
  const homeIds = new Set(await Promise.all(homes.map((home) => folderId(home).catch(() => null))))
  const dated = dirname(stem).split('/')
  const resolved: ProtectedRoot[] = []
  for (const root of protectedRoots) {
    const realPath = await realpathUnlessAbsent(root)
    if (!realPath) {
      continue
    }
    const rootId = await folderId(realPath)
    if (rootId && homeIds.has(rootId)) {
      continue
    }
    // Where this rollout's names or marker sit in the root: a home folder that is one of these
    // (linked, mounted, or spelled another way) holds the root's own files.
    const ids = await Promise.all(
      [
        join(realPath, 'sessions', ...dated),
        join(realPath, 'archived_sessions'),
        join(realPath, '.orca-session-copies', ...dated),
        join(realPath, ...dated)
      ].map(folderId)
    )
    resolved.push({ realPath, folderIds: new Set(ids.filter((id) => id !== null)) })
  }
  return resolved
}

/** False when the name's folder is one of a root's folders or really inside it; checked right before removal. */
export async function isOutsideProtectedRoots(
  path: string,
  protectedRoots: readonly ProtectedRoot[]
): Promise<boolean> {
  if (protectedRoots.length === 0) {
    return true
  }
  const folder = dirname(path)
  const [id, realFolder] = await Promise.all([folderId(folder), realpathUnlessAbsent(folder)])
  if (realFolder === null) {
    return false
  }
  return !protectedRoots.some(
    (root) =>
      (id !== null && root.folderIds.has(id)) || isPathInsideOrEqual(root.realPath, realFolder)
  )
}
