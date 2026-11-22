import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isPathInsideOrEqual } from '../../../../shared/file-access/cross-platform-path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { wslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'

/** Orca's homes to delete in, and roots (the user's import folder) no deletion may reach. */
export type RolloutHomes = { homes: readonly string[]; protectedRoots: readonly string[] }

/**
 * A protected root as seen from one rollout: the dev:ino of the root and of the folders that hold
 * this rollout in it, or, on a filesystem that gives the root no inode, its real path. A root in WSL
 * is never read, and stands for its whole distro.
 */
export type ProtectedRoot = { folderIds: ReadonlySet<string>; inodelessRealPath: string | null }

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

/** The root of the WSL distro a Windows path is in (`\\?\UNC\` spellings too); null for any other. */
function wslDistroRoot(path: string): string | null {
  const distro = wslDistroForPath(path.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\'))
  return distro ? `\\\\wsl.localhost\\${distro}` : null
}

/** Without inodes to compare, only a home whose real path is exactly the root's is that root. */
async function isHomeRealPath(homes: readonly string[], realPath: string): Promise<boolean> {
  const homePaths = await Promise.all(
    homes.map((home) => realpathUnlessAbsent(home).catch(() => null))
  )
  return homePaths.includes(realPath)
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
    // Reading it would boot a stopped distro, and links inside the distro can reach it by any path
    // there: every name that resolves into that distro stays.
    const wslRoot = wslDistroRoot(root)
    if (wslRoot) {
      resolved.push({ folderIds: new Set(), inodelessRealPath: wslRoot })
      continue
    }
    const realPath = await realpathUnlessAbsent(root)
    if (!realPath) {
      continue
    }
    const rootId = await folderId(realPath)
    if (rootId ? homeIds.has(rootId) : await isHomeRealPath(homes, realPath)) {
      continue
    }
    // Where this rollout's names or marker sit in the root: a home's subfolder mounted from one of
    // these has no ancestor that is the root itself.
    const ids = await Promise.all(
      [
        join(realPath, 'sessions', ...dated),
        join(realPath, 'archived_sessions'),
        join(realPath, '.orca-session-copies', ...dated)
      ].map(folderId)
    )
    resolved.push({
      folderIds: new Set([rootId, ...ids].filter((id) => id !== null)),
      inodelessRealPath: rootId === null ? realPath : null
    })
  }
  return resolved
}

/**
 * False when the name's folder, or any folder above it, is a protected root or one of its folders;
 * checked right before removal. Identity, not spelling: a link, mount or other spelling of the root
 * is still the root.
 */
export async function isOutsideProtectedRoots(
  path: string,
  protectedRoots: readonly ProtectedRoot[]
): Promise<boolean> {
  if (protectedRoots.length === 0) {
    return true
  }
  const realFolder = await realpathUnlessAbsent(dirname(path))
  if (realFolder === null) {
    return false
  }
  if (
    protectedRoots.some(
      (root) =>
        root.inodelessRealPath !== null && isPathInsideOrEqual(root.inodelessRealPath, realFolder)
    )
  ) {
    return false
  }
  // A root in WSL has no ids to find.
  if (protectedRoots.every((root) => root.folderIds.size === 0)) {
    return true
  }
  for (let folder = realFolder; ; folder = dirname(folder)) {
    const id = await folderId(folder)
    if (id !== null && protectedRoots.some((root) => root.folderIds.has(id))) {
      return false
    }
    if (dirname(folder) === folder) {
      return true
    }
  }
}
