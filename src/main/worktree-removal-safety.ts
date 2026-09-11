import { lstat, readFile } from 'node:fs/promises'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual } from './ipc/worktree-logic'
import {
  containsPath,
  getPathOps,
  isHomeDirectoryRemovalPath,
  type WorktreeRemovalHomeAuthority
} from './worktree-removal-home-guard'
import {
  gitFileProvesOrphanedWorktreeDirectory,
  type ReadPath,
  type StatPath
} from './worktree-orphan-gitdir-proof'

const ORCA_CREATION_SOURCES = new Set<NonNullable<WorktreeMeta['orcaCreationSource']>>([
  'desktop',
  'runtime',
  'cli',
  'ssh'
])
const ORCA_OWNED_PROVENANCE_META_KEYS = [
  'orcaCreatedAt',
  'orcaCreationSource',
  'orcaCreationWorkspaceLayout',
  'automationProvenance',
  'cliProvenance',
  'creatorProvenance'
] as const
type UnregisteredOrcaCleanupMeta = Pick<
  WorktreeMeta,
  | 'orcaCreatedAt'
  | 'orcaCreationSource'
  | 'createdAt'
  | 'createdWithAgent'
  | 'pushTarget'
  | 'sparseBaseRef'
  | 'sparsePresetId'
  | 'preserveBranchOnDelete'
>

export const ORPHANED_WORKTREE_DIRECTORY_MESSAGE =
  'Worktree is no longer registered with Git but its directory remains.'
export const UNREGISTERED_MISSING_WORKTREE_MESSAGE =
  'Worktree is no longer registered with Git and its directory is already gone.'

/**
 * `home` names the machine the removal executes on, because a home directory is
 * only ever a property of that machine — see `worktree-removal-home-guard.ts`.
 */
export function isDangerousWorktreeRemovalPath(
  worktreePath: string,
  repoPath: string,
  home: WorktreeRemovalHomeAuthority
): boolean {
  if (!worktreePath.trim()) {
    return true
  }

  if (areWorktreePathsEqual(worktreePath, repoPath)) {
    return true
  }

  const pathOps = getPathOps(worktreePath, repoPath)
  const resolvedWorktreePath = pathOps.resolve(worktreePath)
  const rootPath = pathOps.parse(resolvedWorktreePath).root
  if (resolvedWorktreePath === rootPath) {
    return true
  }

  const resolvedRepoPath = pathOps.resolve(repoPath)
  if (containsPath(resolvedWorktreePath, resolvedRepoPath, pathOps)) {
    return true
  }

  return isHomeDirectoryRemovalPath(worktreePath, home)
}

export function getRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly GitWorktreeInfo[],
  home: WorktreeRemovalHomeAuthority
): GitWorktreeInfo {
  const worktree = findRegisteredDeletableWorktree(repoPath, requestedWorktreePath, worktrees, home)
  if (!worktree) {
    throw new Error(`Refusing to delete unregistered worktree path: ${requestedWorktreePath}`)
  }
  return worktree
}

export function findRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly GitWorktreeInfo[],
  home: WorktreeRemovalHomeAuthority
): GitWorktreeInfo | null {
  const worktree = worktrees.find((item) => areWorktreePathsEqual(item.path, requestedWorktreePath))
  if (!worktree) {
    return null
  }
  if (worktree.isMainWorktree || isDangerousWorktreeRemovalPath(worktree.path, repoPath, home)) {
    throw new Error(`Refusing to delete protected worktree path: ${worktree.path}`)
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktree.path, worktrees)
  return worktree
}

export function assertWorktreeDoesNotContainRegisteredWorktree(
  worktreePath: string,
  worktrees: readonly GitWorktreeInfo[]
): void {
  const nestedWorktree = worktrees.find((item) => {
    if (areWorktreePathsEqual(item.path, worktreePath)) {
      return false
    }
    return containsPath(worktreePath, item.path, getPathOps(worktreePath, item.path))
  })
  if (nestedWorktree) {
    // Why: `git worktree remove --force` treats nested worktrees as ordinary
    // untracked directories and deletes their working files while leaving Git
    // with a prunable child worktree record.
    throw new Error(
      `Refusing to delete worktree because it contains another registered worktree: ${nestedWorktree.path}`
    )
  }
}

export async function canSafelyRemoveOrphanedWorktreeDirectory(
  worktreePath: string,
  repoPath: string,
  home: WorktreeRemovalHomeAuthority,
  statPath: StatPath = lstat,
  readPath: ReadPath = (path) => readFile(path, 'utf8')
): Promise<boolean> {
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath, home)) {
    return false
  }

  const pathOps = getPathOps(worktreePath, repoPath)
  const gitFilePath = pathOps.join(worktreePath, '.git')
  return gitFileProvesOrphanedWorktreeDirectory({
    gitFilePath,
    worktreePath,
    repoPath,
    pathOps,
    statPath,
    readPath
  })
}

export function canCleanupUnregisteredOrcaWorktreeDirectory(args: {
  meta: UnregisteredOrcaCleanupMeta | null | undefined
}): boolean {
  if (hasCurrentOrcaCreationProvenance(args.meta)) {
    return true
  }

  if (hasLegacyOrcaCreationEvidence(args.meta)) {
    return true
  }

  // Why: path shape alone is not authority; users can create plain Git
  // worktrees inside Orca's workspace directory too.
  return false
}

export async function canCleanupUnregisteredOrcaLeftoverDirectory(args: {
  meta: UnregisteredOrcaCleanupMeta | null | undefined
  worktreePath: string
  runtimeWorktreePath: string
  repo: Pick<Repo, 'path'>
  runtimeRepoPath: string
  registeredWorktrees: readonly GitWorktreeInfo[]
  statPath: StatPath
  home: WorktreeRemovalHomeAuthority
  isGitRepository: (runtimeWorktreePath: string) => Promise<boolean>
}): Promise<boolean> {
  // Why: this recovery state has already lost the worktree .git marker, so the
  // existing .git-file orphan proof cannot establish ownership.
  // Why: without a surviving .git file, path shape alone is too weak to prove
  // ownership for recursive deletion; require persisted Orca-created evidence.
  if (!hasCurrentOrcaCreationProvenance(args.meta) && !hasLegacyOrcaCreationEvidence(args.meta)) {
    return false
  }

  if (
    isDangerousWorktreeRemovalPath(args.worktreePath, args.repo.path, args.home) ||
    isDangerousWorktreeRemovalPath(args.runtimeWorktreePath, args.runtimeRepoPath, args.home)
  ) {
    return false
  }

  assertWorktreeDoesNotContainRegisteredWorktree(args.worktreePath, args.registeredWorktrees)

  const targetEntry = await args.statPath(args.runtimeWorktreePath).catch(() => null)
  if (!isDirectoryStat(targetEntry)) {
    return false
  }

  const pathOps = getPathOps(args.runtimeWorktreePath, args.runtimeRepoPath)
  const gitMarkerPath = pathOps.join(args.runtimeWorktreePath, '.git')
  try {
    await args.statPath(gitMarkerPath)
    return false
  } catch (error) {
    if (!isMissingPathError(error)) {
      return false
    }
  }

  return !(await args.isGitRepository(args.runtimeWorktreePath))
}

function hasCurrentOrcaCreationProvenance(
  meta: Pick<WorktreeMeta, 'orcaCreatedAt' | 'orcaCreationSource'> | null | undefined
): boolean {
  return (
    typeof meta?.orcaCreatedAt === 'number' &&
    !!meta.orcaCreationSource &&
    ORCA_CREATION_SOURCES.has(meta.orcaCreationSource)
  )
}

function hasLegacyOrcaCreationEvidence(
  meta: UnregisteredOrcaCleanupMeta | null | undefined
): boolean {
  return Boolean(
    meta?.createdAt ||
    meta?.createdWithAgent ||
    meta?.pushTarget ||
    meta?.sparseBaseRef ||
    meta?.sparsePresetId ||
    meta?.preserveBranchOnDelete
  )
}

export function stripOrcaProvenanceMetaUpdates(
  updates: Partial<WorktreeMeta> | null | undefined
): Partial<WorktreeMeta> {
  const sanitized = { ...updates }
  for (const key of ORCA_OWNED_PROVENANCE_META_KEYS) {
    delete sanitized[key]
  }
  return sanitized
}

function isMissingPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }

  let message = ''
  if (error instanceof Error) {
    message = error.message
  } else if (error && typeof error === 'object' && 'message' in error) {
    message = String((error as { message: unknown }).message)
  } else if (typeof error === 'string') {
    message = error
  }
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|cannot find (?:the )?(?:file|path)|(?:file|path) not found/i.test(
    message
  )
}

function isDirectoryStat(stat: unknown): boolean {
  const entry =
    stat && typeof stat === 'object'
      ? (stat as { isDirectory?: () => boolean; isSymbolicLink?: () => boolean; type?: unknown })
      : null
  if (!entry) {
    return false
  }
  if (entry.isSymbolicLink?.() === true || entry.type === 'symlink') {
    return false
  }
  return entry.isDirectory?.() === true || entry.type === 'directory'
}

export async function isWorktreePathMissing(
  worktreePath: string,
  statPath: (path: string) => Promise<unknown> = lstat
): Promise<boolean> {
  try {
    await statPath(worktreePath)
    return false
  } catch (error) {
    return isMissingPathError(error)
  }
}
