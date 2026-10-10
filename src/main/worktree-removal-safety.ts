import { lstat, readFile } from 'node:fs/promises'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { NESTED_WORKTREE_REMOVAL_PREFIX } from '../shared/worktree/nested-removal'
import { areWorktreePathsEqual } from './ipc/worktree-logic'
import {
  containsPath,
  getPathOps,
  isHomeDirectoryRemovalPath,
  isRemovalHomeAuthorityResolved,
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

  // Raw, not `resolvedWorktreePath`: the guard re-reads the path under its own syntax too.
  return isHomeDirectoryRemovalPath(worktreePath, pathOps, home)
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
  if (
    !isRemovalHomeAuthorityResolved(home) ||
    worktree.isMainWorktree ||
    isDangerousWorktreeRemovalPath(worktree.path, repoPath, home)
  ) {
    throw new Error(`Refusing to delete protected worktree path: ${worktree.path}`)
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktree.path, worktrees)
  return worktree
}

export function assertWorktreeDoesNotContainRegisteredWorktree(
  worktreePath: string,
  worktrees: readonly Pick<GitWorktreeInfo, 'path'>[]
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
    throw new Error(`${NESTED_WORKTREE_REMOVAL_PREFIX} ${nestedWorktree.path}`)
  }
}

export async function canSafelyRemoveOrphanedWorktreeDirectory(
  worktreePath: string,
  repoPath: string,
  home: WorktreeRemovalHomeAuthority,
  statPath: StatPath = lstat,
  readPath: ReadPath = (path) => readFile(path, 'utf8')
): Promise<boolean> {
  // Why: this answer authorises a recursive delete, and the proof it relies on — a `.git` file at
  // the top of the directory — is also what a bare-repo dotfiles home looks like. An execution host
  // that never named its home leaves that check with nothing to compare against, and
  // `unverifiable` does not authorise a delete (docs/reference/ssh-execution-boundary.md).
  if (!isRemovalHomeAuthorityResolved(home)) {
    return false
  }

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
