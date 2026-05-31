import { lstat, readFile } from 'fs/promises'
import { homedir } from 'os'
import { posix, win32 } from 'path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { GitWorktreeInfo, OrcaWorkspaceLayout, Repo, WorktreeMeta } from '../shared/types'
import { matchesStrongOrcaCreatePath } from '../shared/worktree-ownership'
import { areWorktreePathsEqual } from './ipc/worktree-logic'
import {
  gitFileProvesOrphanedWorktreeDirectory,
  type ReadPath,
  type StatPath
} from './worktree-orphan-gitdir-proof'

type PathOps = typeof posix

const ORCA_CREATION_SOURCES = new Set<NonNullable<WorktreeMeta['orcaCreationSource']>>([
  'desktop',
  'runtime',
  'cli',
  'ssh'
])
const ORCA_OWNED_PROVENANCE_META_KEYS = [
  'orcaCreatedAt',
  'orcaCreationSource',
  'orcaCreationWorkspaceLayout'
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

function getPathOps(...paths: string[]): PathOps {
  // Why: forward-slash UNC roots need win32 ops; POSIX joins collapse `//Server` to `/Server`.
  return paths.some(isWindowsAbsolutePathLike) ? win32 : posix
}

function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath)
  // Why: `..name` is a valid child name; only `..` and `../...` escape.
  return (
    relativePath === '' ||
    (!!relativePath &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${pathOps.sep}`) &&
      !pathOps.isAbsolute(relativePath))
  )
}

export function isDangerousWorktreeRemovalPath(worktreePath: string, repoPath: string): boolean {
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

  const homePath = homedir()
  return !!homePath && containsPath(resolvedWorktreePath, pathOps.resolve(homePath), pathOps)
}

export function getRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly GitWorktreeInfo[]
): GitWorktreeInfo {
  const worktree = findRegisteredDeletableWorktree(repoPath, requestedWorktreePath, worktrees)
  if (!worktree) {
    throw new Error(`Refusing to delete unregistered worktree path: ${requestedWorktreePath}`)
  }
  return worktree
}

export function findRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly GitWorktreeInfo[]
): GitWorktreeInfo | null {
  const worktree = worktrees.find((item) => areWorktreePathsEqual(item.path, requestedWorktreePath))
  if (!worktree) {
    return null
  }
  if (worktree.isMainWorktree || isDangerousWorktreeRemovalPath(worktree.path, repoPath)) {
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
  statPath: StatPath = lstat,
  readPath: ReadPath = (path) => readFile(path, 'utf8')
): Promise<boolean> {
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath)) {
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
  worktreePath: string
  repo: Pick<Repo, 'path'>
  knownOrcaLayouts: readonly OrcaWorkspaceLayout[]
}): boolean {
  if (hasCurrentOrcaCreationProvenance(args.meta)) {
    return true
  }

  if (hasLegacyOrcaCreationEvidence(args.meta)) {
    return true
  }

  // Why: profiles created before explicit provenance can still contain Orca
  // workspaces at the repo-specific workspaceDir/<repo>/<name> path shape.
  return matchesStrongOrcaCreatePath(args.worktreePath, args.knownOrcaLayouts, args.repo)
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
