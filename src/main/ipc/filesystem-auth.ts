/* eslint-disable max-lines -- Why: keeps the filesystem-auth security boundary auditable end to end. */
import { resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { isRepoRoot, listRepoWorktrees } from '../repo-worktrees'
import { computeWorkspaceRoot, getWorktreePathSettings } from './worktree-logic'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'

export const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
// Why: authorized external paths accumulate all session; LRU-bound the set. Safe to evict because every caller re-authorizes before operating.
export const AUTHORIZED_EXTERNAL_PATHS_MAX = 4096
const authorizedExternalPaths = new Set<string>()
const registeredWorktreeRoots = new Set<string>()
const registeredWorktreeRootsByRepo = new Map<string, Set<string>>()
const registeredWorktreeRootRepoIds = new Set<string>()
let registeredWorktreeRootsDirty = true
let registeredWorktreeRootsRefresh: Promise<void> | null = null
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8
type FolderScopeStore = Pick<Store, 'getRepos'> &
  Partial<Pick<Store, 'getProjectGroups' | 'getFolderWorkspaces'>>

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

export function invalidateAuthorizedRootsCache(): void {
  registeredWorktreeRootsDirty = true
  // Why: dirty roots can't be trusted for auth short-circuits; fresh worktrees:list seeds safe per-repo roots before a full rebuild.
  registeredWorktreeRoots.clear()
  registeredWorktreeRootsByRepo.clear()
  registeredWorktreeRootRepoIds.clear()
}

function getLocalRepos(store: Store) {
  // Why: SSH repo paths are remote-host paths; treating them as local roots could authorize unrelated local folders or probe SSH-only paths.
  return store.getRepos().filter((repo) => !repo.connectionId)
}

function getFolderScopeCandidateRepos(
  folderPath: string,
  projectGroupId: string,
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[]
): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(projectGroups, projectGroupId)
  return repos.filter(
    (repo) =>
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(folderPath, repo.path)
  )
}

function isRemoteOnlyFolderScope(
  folderPath: string,
  projectGroupId: string,
  connectionId: string | null | undefined,
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[]
): boolean {
  if (connectionId) {
    return true
  }
  const candidates = getFolderScopeCandidateRepos(folderPath, projectGroupId, projectGroups, repos)
  return candidates.length > 0 && candidates.every((repo) => Boolean(repo.connectionId))
}

function getFolderWorkspaceConnectionId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): string | null {
  return (
    workspace.connectionId ??
    projectGroups.find((group) => group.id === workspace.projectGroupId)?.connectionId ??
    null
  )
}

function getLocalFolderScopeRoots(store: Store): string[] {
  const scopeStore = store as FolderScopeStore
  const repos = scopeStore.getRepos()
  // Why: many filesystem tests use narrow Store doubles; folder scopes are additive.
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const roots: string[] = []
  for (const group of projectGroups) {
    if (
      group.parentPath &&
      !isRemoteOnlyFolderScope(group.parentPath, group.id, group.connectionId, projectGroups, repos)
    ) {
      roots.push(resolve(group.parentPath))
    }
  }
  for (const workspace of scopeStore.getFolderWorkspaces?.() ?? []) {
    if (
      !isRemoteOnlyFolderScope(
        workspace.folderPath,
        workspace.projectGroupId,
        getFolderWorkspaceConnectionId(workspace, projectGroups),
        projectGroups,
        repos
      )
    ) {
      roots.push(resolve(workspace.folderPath))
    }
  }
  return roots
}

/**
 * Check whether resolvedTarget is equal to or a descendant of resolvedBase.
 * Uses relative() so it works with both `/` (Unix) and `\` (Windows) separators.
 */
export function isDescendantOrEqual(resolvedTarget: string, resolvedBase: string): boolean {
  if (resolvedTarget === resolvedBase) {
    return true
  }
  const rel = relative(resolvedBase, resolvedTarget)
  // Security: reject "..", "../…" or an absolute rel — on Windows relative() returns absolute across drives, which would bypass drive-traversal checks.
  // Use isAbsolute, not rejoin+compare: Windows path.relative() ignores drive/root casing, so rejoining would deny valid c:\repo under C:\Repo.
  return rel !== '' && !(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)
}

export function getAllowedRoots(store: Store): string[] {
  const localRepos = getLocalRepos(store)
  const settings = store.getSettings()
  const roots = [
    ...localRepos.map((repo) => resolve(repo.path)),
    ...getLocalFolderScopeRoots(store)
  ]
  if (settings.workspaceDir) {
    if (localRepos.length === 0) {
      roots.push(resolve(settings.workspaceDir))
    } else {
      for (const repo of localRepos) {
        roots.push(
          resolve(computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings)))
        )
      }
    }
  }
  return roots
}

export function isPathAllowed(targetPath: string, store: Store): boolean {
  const resolvedTarget = resolve(targetPath)
  if (authorizedExternalPaths.has(resolvedTarget)) {
    return true
  }
  for (const authorizedPath of authorizedExternalPaths) {
    if (isDescendantOrEqual(resolvedTarget, authorizedPath)) {
      return true
    }
  }
  return getAllowedRoots(store).some((root) => isDescendantOrEqual(resolvedTarget, root))
}

export async function rebuildAuthorizedRootsCache(store: Store): Promise<void> {
  // Why: bounded parallelism keeps the Windows speedup without one git process per repo.
  // Why no realpath here: canonicalizing every root on invalidation would trigger macOS TCC prompts; handlers still canonicalize the target before any operation.
  const repos = getLocalRepos(store)
  const perProjectResults = await mapWithConcurrency(
    repos,
    AUTHORIZED_ROOTS_REBUILD_CONCURRENCY,
    async (repo) => {
      const roots: string[] = []
      try {
        roots.push(resolve(repo.path))

        for (const worktree of await listRepoWorktrees(repo)) {
          roots.push(resolve(worktree.path))
        }
      } catch (error) {
        // Why: one inaccessible repo (EACCES/EIO) must not break the whole rebuild and disable File Explorer/Quick Open for the rest; skip it.
        console.warn(`[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`, error)
      }
      return { repoId: repo.id, roots }
    }
  )

  registeredWorktreeRoots.clear()
  registeredWorktreeRootsByRepo.clear()
  registeredWorktreeRootRepoIds.clear()
  for (const { repoId, roots } of perProjectResults) {
    const normalizedRoots = new Set<string>()
    for (const root of roots) {
      normalizedRoots.add(root)
      registeredWorktreeRoots.add(root)
    }
    registeredWorktreeRootsByRepo.set(repoId, normalizedRoots)
    registeredWorktreeRootRepoIds.add(repoId)
  }
  registeredWorktreeRootsDirty = false
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrent: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(maxConcurrent, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index])
      }
    })
  )
  return results
}

export function registerWorktreeRootsForRepo(
  store: Store,
  repoId: string,
  worktreeRoots: string[]
): void {
  const localRepoIds = new Set(getLocalRepos(store).map((repo) => repo.id))
  for (const registeredRepoId of registeredWorktreeRootsByRepo.keys()) {
    if (!localRepoIds.has(registeredRepoId)) {
      registeredWorktreeRootsByRepo.delete(registeredRepoId)
      registeredWorktreeRootRepoIds.delete(registeredRepoId)
    }
  }

  if (!localRepoIds.has(repoId)) {
    refreshRegisteredWorktreeRoots()
    registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
    return
  }

  registeredWorktreeRootsByRepo.set(repoId, new Set(worktreeRoots.map((root) => resolve(root))))
  registeredWorktreeRootRepoIds.add(repoId)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = !allLocalRepoRootsRegistered(localRepoIds)
}

export async function ensureAuthorizedRootsCache(store: Store): Promise<void> {
  if (!registeredWorktreeRootsDirty) {
    return
  }
  if (!registeredWorktreeRootsRefresh) {
    registeredWorktreeRootsRefresh = rebuildAuthorizedRootsCache(store).finally(() => {
      registeredWorktreeRootsRefresh = null
    })
  }
  await registeredWorktreeRootsRefresh
}

/**
 * Returns true if the error is an ENOENT (file-not-found) error.
 */
export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
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
  if (!(await isPathAllowedIncludingRegisteredWorktrees(resolvedTarget, store))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }

  if (options.preserveSymlink) {
    // Canonicalize the parent so ancestor symlinks can't redirect outside allowed roots, but keep the leaf so delete/rename act on the link itself.
    let realParent: string
    try {
      realParent = await realpath(dirname(resolvedTarget))
    } catch (error) {
      if (isENOENT(error)) {
        return resolveAuthorizedMissingPath(resolvedTarget, store)
      }
      throw error
    }
    const candidateTarget = resolve(realParent, basename(resolvedTarget))
    if (
      !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
        canonicalSourcePath: resolvedTarget
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
        canonicalSourcePath: resolvedTarget
      }))
    ) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return realTarget
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    return resolveAuthorizedMissingPath(resolvedTarget, store)
  }
}

async function resolveAuthorizedMissingPath(resolvedTarget: string, store: Store): Promise<string> {
  let existingAncestor = resolvedTarget
  const missingSegments: string[] = []

  while (true) {
    try {
      const realAncestor = await realpath(existingAncestor)
      const candidateTarget = resolve(realAncestor, ...missingSegments)
      if (
        !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
          canonicalSourcePath: resolvedTarget
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
  options: { canonicalSourcePath?: string } = {}
): Promise<boolean> {
  if (isPathAllowed(targetPath, store)) {
    return true
  }

  if (isRegisteredWorktreePath(targetPath)) {
    return true
  }

  if (await isPathAllowedByCanonicalAllowedRoot(targetPath, options.canonicalSourcePath, store)) {
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

/**
 * Resolve and verify that a worktree path belongs to a registered repo.
 *
 * Why not resolveAuthorizedPath: linked worktrees can live outside repo/workspace roots; git trusts exact `git worktree list` registration, not containment.
 */
export async function resolveRegisteredWorktreePath(
  worktreePath: string,
  store: Store
): Promise<string> {
  // Reject malformed paths (null byte) early to prevent probing via realpath.
  if (!worktreePath || worktreePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }

  const resolvedTarget = resolve(worktreePath)
  if (registeredWorktreeRoots.has(resolvedTarget) || isRepoRoot(store.getRepos(), resolvedTarget)) {
    return resolvedTarget
  }

  if (registeredWorktreeRootsDirty) {
    await ensureAuthorizedRootsCache(store)
  }

  if (registeredWorktreeRoots.has(resolvedTarget)) {
    return resolvedTarget
  }

  // Resolve symlinks only after the cheap registered-root check: on macOS realpath() can trigger TCC prompts.
  const normalizedTarget = await normalizeExistingPath(resolvedTarget)
  if (registeredWorktreeRoots.has(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error('Access denied: unknown repository or worktree path')
}

function refreshRegisteredWorktreeRoots(): void {
  registeredWorktreeRoots.clear()
  for (const roots of registeredWorktreeRootsByRepo.values()) {
    for (const root of roots) {
      registeredWorktreeRoots.add(root)
    }
  }
}

function allLocalRepoRootsRegistered(localRepoIds: Set<string>): boolean {
  for (const repoId of localRepoIds) {
    if (!registeredWorktreeRootRepoIds.has(repoId)) {
      return false
    }
  }
  return true
}

async function isPathAllowedByCanonicalAllowedRoot(
  targetPath: string,
  sourcePath: string | undefined,
  store: Store
): Promise<boolean> {
  if (!sourcePath) {
    return false
  }
  for (const root of getAllowedRoots(store)) {
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

function isRegisteredWorktreePath(targetPath: string): boolean {
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root)) {
      return true
    }
  }
  return false
}

async function isPathAllowedByCanonicalRegisteredRoot(
  targetPath: string,
  sourcePath: string | undefined
): Promise<boolean> {
  if (!sourcePath) {
    return false
  }
  const textualRoot = findRegisteredWorktreeRoot(sourcePath)
  if (!textualRoot) {
    return false
  }
  const canonicalRoot = await normalizeExistingPath(textualRoot)
  if (!isDescendantOrEqual(targetPath, canonicalRoot)) {
    return false
  }
  // Why: #1524 stopped realpath'ing every root (macOS privacy prompts); cache only the actively-accessed root so /var→/private/var aliases resolve.
  registeredWorktreeRoots.add(canonicalRoot)
  return true
}

function findRegisteredWorktreeRoot(targetPath: string): string | null {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    if (!isDescendantOrEqual(targetPath, root)) {
      continue
    }
    if (!bestRoot || root.length > bestRoot.length) {
      bestRoot = root
    }
  }
  return bestRoot
}

async function normalizeExistingPath(resolvedPath: string): Promise<string> {
  try {
    return resolve(await realpath(resolvedPath))
  } catch (error) {
    if (isENOENT(error)) {
      return resolvedPath
    }
    throw error
  }
}

export function validateGitRelativeFilePath(worktreePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || resolve(filePath) === filePath) {
    throw new Error('Access denied: invalid git file path')
  }

  const resolvedFilePath = resolve(worktreePath, filePath)
  if (!isDescendantOrEqual(resolvedFilePath, worktreePath)) {
    throw new Error('Access denied: git file path escapes the selected worktree')
  }

  const normalizedRelativePath = relative(worktreePath, resolvedFilePath)
  if (!normalizedRelativePath) {
    throw new Error('Access denied: invalid git file path')
  }

  return normalizedRelativePath
}
