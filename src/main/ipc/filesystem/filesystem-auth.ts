import { resolve, dirname, basename } from 'node:path'
import type { RuntimeStore } from '../../runtime/runtime-store-contract'
import { lstat } from 'node:fs/promises'
import { realpathAcrossWslDriveMount, windowsFsPath } from '../../wsl/wsl-unc-drive-fs-path'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../../shared/local-file-access'
import { getAllowedRoots } from './filesystem-allowed-roots'
import { isDescendantOrEqual, isENOENT, normalizeExistingPath } from './filesystem-path-containment'
import {
  ensureAuthorizedRootsCache,
  isPathAllowedByCanonicalRegisteredRoot,
  isRegisteredWorktreePath
} from '../registered-worktree-roots-cache'

export const PATH_ACCESS_DENIED_MESSAGE = `${PATH_OUTSIDE_ALLOWED_DIRECTORIES}. If this blocks a legitimate workflow, please file a GitHub issue.`
/** Lazily share allowed roots across every check in one authorization. */
type AllowedRootsSnapshot = { get: () => Promise<readonly string[]> }

function createAllowedRootsSnapshot(
  store: RuntimeStore,
  extraRoots: readonly string[] = []
): AllowedRootsSnapshot {
  let roots: Promise<readonly string[]> | undefined
  return {
    get: () => (roots ??= getAllowedRoots(store).then((found) => [...found, ...extraRoots]))
  }
}

export async function isPathAllowed(
  targetPath: string,
  store: RuntimeStore,
  allowedRoots?: AllowedRootsSnapshot
): Promise<boolean> {
  const resolvedTarget = resolve(targetPath)
  return (await (allowedRoots?.get() ?? getAllowedRoots(store))).some((root) =>
    isDescendantOrEqual(resolvedTarget, root)
  )
}

export type ResolveAuthorizedPathOptions = {
  /** Canonicalize parents but preserve the leaf so delete/rename act on a symlink, not its destination. */
  preserveSymlink?: boolean
  /** Roots one caller owns outside the store (desktop: floating workspace; runtime: chat scratch). */
  extraRoots?: readonly string[]
}

export async function resolveAuthorizedPath(
  targetPath: string,
  store: RuntimeStore,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  const resolvedTarget = resolve(targetPath)
  // Reuse store-derived roots while fully checking each candidate.
  const allowedRoots = createAllowedRootsSnapshot(store, options.extraRoots)
  if (!(await isPathAllowedIncludingRegisteredWorktrees(resolvedTarget, store, { allowedRoots }))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }

  if (options.preserveSymlink) {
    // Canonicalize the parent so ancestor symlinks can't redirect outside allowed roots, but keep the leaf so delete/rename act on the link itself.
    let realParent: string
    try {
      realParent = await realpathAcrossWslDriveMount(dirname(resolvedTarget))
    } catch (error) {
      if (isENOENT(error)) {
        return resolveAuthorizedMissingPath(resolvedTarget, store, allowedRoots)
      }
      throw error
    }
    const candidateTarget = resolve(realParent, basename(resolvedTarget))
    if (
      !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
        canonicalSourcePath: resolvedTarget,
        allowedRoots
      }))
    ) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return candidateTarget
  }

  try {
    // Normalize Windows/WSL realpath output before comparing allow-list roots.
    const realTarget = resolve(await realpathAcrossWslDriveMount(resolvedTarget))
    if (
      !(await isPathAllowedIncludingRegisteredWorktrees(realTarget, store, {
        canonicalSourcePath: resolvedTarget,
        allowedRoots
      }))
    ) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return realTarget
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    return resolveAuthorizedMissingPath(resolvedTarget, store, allowedRoots)
  }
}

async function resolveAuthorizedMissingPath(
  resolvedTarget: string,
  store: RuntimeStore,
  allowedRoots: AllowedRootsSnapshot
): Promise<string> {
  let existingAncestor = resolvedTarget
  const missingSegments: string[] = []

  while (true) {
    try {
      const realAncestor = await realpathAcrossWslDriveMount(existingAncestor)
      const candidateTarget = resolve(realAncestor, ...missingSegments)
      if (
        !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
          canonicalSourcePath: resolvedTarget,
          allowedRoots
        }))
      ) {
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      return candidateTarget
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
      if (await isSymlink(existingAncestor)) {
        // Writes create dangling-link targets that realpath cannot authorize.
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) {
        throw error
      }
      // Canonicalize the nearest existing ancestor to catch symlink escapes through missing parents.
      missingSegments.unshift(basename(existingAncestor))
      existingAncestor = parent
    }
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    // A UNC drive-mount path opens only through its drive path; lstat there still sees links.
    return (await lstat(windowsFsPath(path))).isSymbolicLink()
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}

async function isPathAllowedIncludingRegisteredWorktrees(
  targetPath: string,
  store: RuntimeStore,
  options: { canonicalSourcePath?: string; allowedRoots?: AllowedRootsSnapshot } = {}
): Promise<boolean> {
  if (await isPathAllowed(targetPath, store, options.allowedRoots)) {
    return true
  }

  if (isRegisteredWorktreePath(targetPath, store)) {
    return true
  }

  if (
    await isPathAllowedByCanonicalAllowedRoot(
      targetPath,
      options.canonicalSourcePath,
      store,
      options.allowedRoots
    )
  ) {
    return true
  }

  if (
    await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath, store)
  ) {
    return true
  }

  await ensureAuthorizedRootsCache(store)

  // Reuse git-trusted registered roots without spawning git worktree list on each read.
  return (
    isRegisteredWorktreePath(targetPath, store) ||
    (await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath, store))
  )
}

async function isPathAllowedByCanonicalAllowedRoot(
  targetPath: string,
  sourcePath: string | undefined,
  store: RuntimeStore,
  allowedRoots?: AllowedRootsSnapshot
): Promise<boolean> {
  if (!sourcePath) {
    return false
  }
  for (const root of await (allowedRoots?.get() ?? getAllowedRoots(store))) {
    const resolvedRoot = resolve(root)
    if (!isDescendantOrEqual(sourcePath, resolvedRoot)) {
      continue
    }
    // Resolve macOS /var symlinks only for the matching root, not every repo.
    const canonicalRoot = await normalizeExistingPath(resolvedRoot)
    if (isDescendantOrEqual(targetPath, canonicalRoot)) {
      return true
    }
  }
  return false
}
