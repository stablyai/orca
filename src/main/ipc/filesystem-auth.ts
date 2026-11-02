import { resolve, dirname, basename } from 'node:path'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { lstat, realpath } from 'node:fs/promises'
import { PATH_OUTSIDE_ALLOWED_DIRECTORIES } from '../../shared/local-file-access'
import { getAllowedRoots } from './filesystem-allowed-roots'
import { isDescendantOrEqual, isENOENT, normalizeExistingPath } from './filesystem-path-containment'
import {
  ensureAuthorizedRootsCache,
  isPathAllowedByCanonicalRegisteredRoot,
  isRegisteredWorktreePath
} from './registered-worktree-roots-cache'

// Compatibility exports for runtime command modules that historically imported these seams from
// filesystem-auth. The implementations remain owned by their focused modules.
export { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
export { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
export { isENOENT } from './filesystem-path-containment'

export const PATH_ACCESS_DENIED_MESSAGE = `${PATH_OUTSIDE_ALLOWED_DIRECTORIES}. If this blocks a legitimate workflow, please file a GitHub issue.`
/** One allowed-root list shared by every check in a single authorization, built on first use. */
type AllowedRootsSnapshot = { get: () => readonly string[] }

function createAllowedRootsSnapshot(
  store: RuntimeStore,
  extraRoots: readonly string[] = []
): AllowedRootsSnapshot {
  let roots: readonly string[] | undefined
  return { get: () => (roots ??= [...getAllowedRoots(store), ...extraRoots]) }
}

export function isPathAllowed(
  targetPath: string,
  store: RuntimeStore,
  allowedRoots?: AllowedRootsSnapshot
): boolean {
  const resolvedTarget = resolve(targetPath)
  return (allowedRoots?.get() ?? getAllowedRoots(store)).some((root) =>
    isDescendantOrEqual(resolvedTarget, root)
  )
}

export type ResolveAuthorizedPathOptions = {
  /**
   * Canonicalize the parent but preserve the leaf so delete/rename target the symlink itself, not its destination (which may live outside allowed roots).
   */
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
  // Why: the roots depend only on store state, not on the candidate path, so one snapshot serves
  // every authorization below; each candidate is still checked against it in full.
  const allowedRoots = createAllowedRootsSnapshot(store, options.extraRoots)
  if (!(await isPathAllowedIncludingRegisteredWorktrees(resolvedTarget, store, { allowedRoots }))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }

  if (options.preserveSymlink) {
    // Canonicalize the parent so ancestor symlinks can't redirect outside allowed roots, but keep the leaf so delete/rename act on the link itself.
    let realParent: string
    try {
      realParent = await realpath(dirname(resolvedTarget))
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
    // Why: Windows/WSL realpath can return UNC-shaped paths; re-resolve to compare against this module's allow-list roots.
    const realTarget = resolve(await realpath(resolvedTarget))
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
      const realAncestor = await realpath(existingAncestor)
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
        // Why: realpath can't say where a dangling link leads, but a write follows it and creates its target.
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) {
        throw error
      }
      // Why: create/copy make missing parents after auth; canonicalize nearest existing ancestor to catch symlink escapes without rejecting nested paths.
      missingSegments.unshift(basename(existingAncestor))
      existingAncestor = parent
    }
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
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
  if (isPathAllowed(targetPath, store, options.allowedRoots)) {
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

  // Why: linked worktrees are already git-trusted; reuse the cached root index so reads don't spawn `git worktree list` each time.
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
  for (const root of allowedRoots?.get() ?? getAllowedRoots(store)) {
    const resolvedRoot = resolve(root)
    if (!isDescendantOrEqual(sourcePath, resolvedRoot)) {
      continue
    }
    // Why: macOS resolves /var→/private/var; canonicalize only the matched root, not the whole repo set.
    const canonicalRoot = await normalizeExistingPath(resolvedRoot)
    if (isDescendantOrEqual(targetPath, canonicalRoot)) {
      return true
    }
  }
  return false
}
