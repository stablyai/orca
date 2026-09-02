import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import type { Store } from '../persistence'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { resolveAuthorizedPath, type ResolveAuthorizedPathOptions } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  isRepositoryAdminPath,
  REPOSITORY_ADMIN_PATH_DENIED_MESSAGE,
  type RepositoryAdminPathFlavour
} from '../../shared/repository-admin-path'

/** The executing host's flavour, read off a path it owns rather than assumed from this process. */
export function repositoryPathFlavourForHost(hostPath: string): RepositoryAdminPathFlavour {
  return isWindowsAbsolutePathLike(hostPath) ? 'win32' : 'posix'
}

/** Refuses a host-absolute mutation target, taking the flavour from the path itself. */
export function assertMutableHostPath(hostPath: string): void {
  if (isRepositoryAdminPath(hostPath, repositoryPathFlavourForHost(hostPath))) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

/**
 * Refuses a worktree-relative mutation target before the local/SSH split.
 *
 * This is the SSH lane's only cover: that branch returns before any path is resolved, so the
 * relative spelling is all there is to classify there.
 */
export function assertMutableRuntimeRelativePath(relativePath: string, worktreePath: string): void {
  if (isRepositoryAdminPath(relativePath, repositoryPathFlavourForHost(worktreePath))) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

export const REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE =
  'Access denied: this file has more than one name on disk, so writing through it could modify Git repository metadata.'

/**
 * Classifies a mutation target on a REMOTE execution host.
 *
 * The SSH branch returns before any local authorization, so the caller's relative spelling is all
 * the client ever sees — and a guest-side symlink makes that spelling lie. `fs.realpath` has been
 * on the relay since 2026-07-26; when a host predates it (or the tree genuinely is not there), this
 * stays PERMISSIVE rather than bricking ordinary remote editing, which would be worse than the hole.
 *
 * Client-side by construction: it closes the lane for this client, and does not make the host safe
 * against an older or third-party client.
 */
export async function assertMutableRemotePath(
  provider: { realpath?(remotePath: string): Promise<string> },
  remotePath: string,
  worktreePath: string,
  options: { followsLink?: boolean } = {}
): Promise<void> {
  const flavour = repositoryPathFlavourForHost(worktreePath)
  const canonical = await canonicalRemotePath(provider, remotePath, flavour, options.followsLink)
  if (canonical !== undefined && isRepositoryAdminPath(canonical, flavour)) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

async function canonicalRemotePath(
  provider: { realpath?(remotePath: string): Promise<string> },
  remotePath: string,
  flavour: RepositoryAdminPathFlavour,
  followsLink?: boolean
): Promise<string | undefined> {
  // A host or provider without realpath cannot be classified; stay permissive rather than break
  // every remote mutation against it.
  if (typeof provider.realpath !== 'function') {
    return undefined
  }
  const realpathRemote = provider.realpath.bind(provider)
  const path = flavour === 'win32' ? win32 : posix
  if (followsLink) {
    const resolved = await realpathRemote(remotePath).catch(() => undefined)
    if (resolved !== undefined) {
      return resolved
    }
  }
  // Entry semantics, or a target that does not exist yet: canonicalize the parent and keep the leaf
  // so renaming or deleting a symlink still acts on the link itself.
  const parent = await realpathRemote(path.dirname(remotePath)).catch(() => undefined)
  return parent === undefined ? undefined : path.join(parent, path.basename(remotePath))
}

export type ResolveAuthorizedMutablePathOptions = ResolveAuthorizedPathOptions & {
  /**
   * The syscall acts on the OBJECT a name points at rather than on the directory entry — copy reads
   * and writes through it, `writeFile` truncates through it. Rename and delete act on the entry, so
   * they leave this off. Set it to classify the link target and refuse multi-named inodes.
   */
  followsLink?: boolean
}

/**
 * Authorizes a file-explorer mutation, then refuses repository admin state on the path the
 * filesystem will actually touch.
 *
 * The caller's relative spelling is not enough on its own: a symlinked ancestor (`foo -> .git`)
 * carries no `.git` segment, yet `resolveAuthorizedPath` canonicalizes it — including through the
 * nearest existing ancestor of a not-yet-created path — straight into `.git`.
 *
 * Fails closed: `resolveAuthorizedPath` throws when it cannot canonicalize, so an unclassifiable
 * path never reaches the check.
 */
export async function resolveAuthorizedMutablePath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedMutablePathOptions = {}
): Promise<string> {
  const { followsLink, ...authorizationOptions } = options
  const resolvedPath = await resolveAuthorizedPath(targetPath, store, authorizationOptions)
  assertMutablePath(resolvedPath)
  if (followsLink) {
    assertMutablePath(await canonicalLeaf(resolvedPath))
    await assertNotHardLinked(resolvedPath)
  } else if (authorizationOptions.preserveSymlink) {
    await assertMutableUnlessSymlink(resolvedPath)
  }
  return resolvedPath
}

/**
 * Classifies the canonicalized leaf of an entry-semantics operand, unless the leaf IS a symlink.
 *
 * `preserveSymlink` keeps the leaf verbatim so rename and delete act on the link itself, which also
 * means an alias for `.git` that is not a symlink — a Win32 8.3 short name such as `GIT~1` — is
 * never canonicalized. Skipping actual symlinks preserves the legitimate "remove the link" case.
 *
 * Unverified on Windows: this is measured only to not regress POSIX, and is NOT evidence that it
 * catches `GIT~1` on a short-name-enabled NTFS volume.
 */
async function assertMutableUnlessSymlink(path: string): Promise<void> {
  let stats: { isSymbolicLink?: () => boolean }
  try {
    stats = await lstat(path)
  } catch (error) {
    // Nothing on disk yet cannot alias anything; other failures surface on the syscall itself.
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  // Only a confirmed symlink is exempt. Anything we cannot ask takes the stricter branch below.
  if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
    return
  }
  assertMutablePath(await canonicalLeaf(path))
}

/**
 * Refuses a file that has more than one name on disk.
 *
 * A hard link into `.git` cannot be detected by path: every name for the inode is equally real and
 * `realpath` returns the one it was given. Link count is the only portable signal that another name
 * — possibly inside `.git` — reaches the same bytes. Mirrors the existing `nlink > 1` refusal on
 * terminal artifacts.
 *
 * Partial by nature: `nlink` is not dependable on Windows, so this closes the POSIX case only.
 */
async function assertNotHardLinked(path: string): Promise<void> {
  let linkCount: number | undefined
  try {
    linkCount = (await lstat(path)).nlink
  } catch (error) {
    // Nothing on disk yet has no aliases. Any other stat failure aborts the mutation on its own
    // error, which the following syscall would raise anyway, so it is not restated as a refusal.
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  // Fails closed like its neighbour above: a link count we cannot read leaves us unable to rule out
  // another name reaching these bytes, and an unclassifiable input takes the refusing branch.
  if (typeof linkCount !== 'number' || linkCount > 1) {
    throw new Error(REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE)
  }
}

function assertMutablePath(path: string): void {
  if (isRepositoryAdminPath(path, process.platform === 'win32' ? 'win32' : 'posix')) {
    throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
  }
}

async function canonicalLeaf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!isENOENT(error)) {
      // Fail closed: the leaf exists but cannot be canonicalized, so what it points at is unknown.
      throw new Error(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
    }
  }
  // ENOENT also covers a DANGLING symlink, and `writeFile` follows one to CREATE its target — so
  // returning the link's own name here would classify the wrong path. Resolve it by hand.
  return await danglingLinkTarget(path)
}

async function danglingLinkTarget(path: string): Promise<string> {
  let linkTarget: string
  try {
    linkTarget = await readlink(path)
  } catch {
    // Not a symlink, or unreadable: nothing points anywhere, so the path stands for itself.
    return path
  }
  const resolvedTarget = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(path), linkTarget)
  // The target's own parent may exist even though the target does not; canonicalize what is there.
  return await realpath(dirname(resolvedTarget))
    .then((parent) => join(parent, basename(resolvedTarget)))
    .catch(() => resolvedTarget)
}
