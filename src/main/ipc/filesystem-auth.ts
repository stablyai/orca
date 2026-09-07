import { resolve, dirname, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
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
export { isENOENT } from './filesystem-path-containment'

export const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
// Why: authorized external paths accumulate all session; LRU-bound the set. Safe to evict because every caller re-authorizes before operating.
export const AUTHORIZED_EXTERNAL_PATHS_MAX = 4096
const authorizedExternalPaths = new Set<string>()

function rememberAuthorizedExternalPath(path: string): void {
  // Delete-then-add makes re-authorized paths most-recent so LRU eviction sheds only the oldest untouched entries.
  authorizedExternalPaths.delete(path)
  authorizedExternalPaths.add(path)
  while (authorizedExternalPaths.size > AUTHORIZED_EXTERNAL_PATHS_MAX) {
    const oldest = authorizedExternalPaths.keys().next().value
    if (oldest === undefined) {
      break
    }
    authorizedExternalPaths.delete(oldest)
  }
}

export function authorizeExternalPath(targetPath: string): void {
  const resolvedTarget = resolve(targetPath)
  rememberAuthorizedExternalPath(resolvedTarget)
  try {
    // Why: macOS canonicalizes /tmp to /private/tmp during read authorization.
    rememberAuthorizedExternalPath(realpathSync(resolvedTarget))
  } catch {}
}

/**
 * One allowed-root list shared by every check in a single authorization.
 *
 * Lazy so a path already covered by an external grant still builds nothing at all, the way it did
 * before the list was hoisted out of the individual checks.
 */
type AllowedRootsSnapshot = { get: () => readonly string[] }

function createAllowedRootsSnapshot(store: Store): AllowedRootsSnapshot {
  let roots: readonly string[] | undefined
  return { get: () => (roots ??= getAllowedRoots(store)) }
}

export function isPathAllowed(
  targetPath: string,
  store: Store,
  allowedRoots?: AllowedRootsSnapshot
): boolean {
  const resolvedTarget = resolve(targetPath)
  if (authorizedExternalPaths.has(resolvedTarget)) {
    return true
  }
  for (const authorizedPath of authorizedExternalPaths) {
    if (isDescendantOrEqual(resolvedTarget, authorizedPath)) {
      return true
    }
  }
  return (allowedRoots?.get() ?? getAllowedRoots(store)).some((root) =>
    isDescendantOrEqual(resolvedTarget, root)
  )
}

export type ResolveAuthorizedPathOptions = {
  /**
   * Canonicalize the parent but preserve the leaf so delete/rename target the symlink itself, not its destination (which may live outside allowed roots).
   */
  preserveSymlink?: boolean
}

export async function resolveAuthorizedPath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  const resolvedTarget = resolve(targetPath)
  // Why: the roots depend only on store state, not on the candidate path, so one snapshot serves
  // every authorization below; each candidate is still checked against it in full.
  const allowedRoots = createAllowedRootsSnapshot(store)
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
  store: Store,
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

async function isPathAllowedIncludingRegisteredWorktrees(
  targetPath: string,
  store: Store,
  options: { canonicalSourcePath?: string; allowedRoots?: AllowedRootsSnapshot } = {}
): Promise<boolean> {
  if (isPathAllowed(targetPath, store, options.allowedRoots)) {
    return true
  }

  if (isRegisteredWorktreePath(targetPath)) {
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

  if (await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath)) {
    return true
  }

  await ensureAuthorizedRootsCache(store)

  // Why: linked worktrees are already git-trusted; reuse the cached root index so reads don't spawn `git worktree list` each time.
  return (
    isRegisteredWorktreePath(targetPath) ||
    (await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath))
  )
}

async function isPathAllowedByCanonicalAllowedRoot(
  targetPath: string,
  sourcePath: string | undefined,
  store: Store,
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
