import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { readWorktreeListWithForm } from '../worktree-list-reader'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { translateWorktreePath } from '../worktree-path-comparison'
import { annotateSparseCheckoutStatus } from '../worktree-sparse-annotation'
import {
  isAdminStatSignatureUnchanged,
  readAdminStatSignature,
  readAdminStatStamp,
  type AdminStatDependency,
  type AdminStatSignature
} from './admin-stat-signature'
import { isSafeRefName } from './worktree-admin-file-reads'
import { compareWorktreePathsLikeGit } from './worktree-membership-file-rows'
import type { GitDerivationState } from './worktree-membership-model'

/** `git worktree list`, translated into the caller's path space, with Orca's sparse annotation. */
export async function readGitWorktreeRows(
  repoPath: string,
  options: GitWorktreeExecOptions,
  annotateSparse = true
): Promise<{ rows: GitWorktreeInfo[]; nulDelimited: boolean }> {
  const { worktrees, nulDelimited } = await readWorktreeListWithForm(repoPath, options)
  const translated = worktrees.map((worktree) => {
    const path = translateWorktreePath(worktree.path, repoPath, options)
    return path === worktree.path ? worktree : { ...worktree, path }
  })
  const rows = annotateSparse
    ? await annotateSparseCheckoutStatus(repoPath, translated, options)
    : translated
  return { rows, nulDelimited }
}

/**
 * What a git-derived model stats to decide whether Git must run again: the same admin files the
 * file rules read, minus each entry's directory (it moves on every index write) and plus the
 * reftable stack, which is where a branch moves when there are no loose refs.
 */
function gitDependencies(
  commonDir: string,
  entryNames: readonly string[],
  rows: readonly GitWorktreeInfo[]
): AdminStatDependency[] {
  const dependencies: AdminStatDependency[] = [
    { path: join(commonDir, 'HEAD') },
    { path: join(commonDir, 'config') },
    { path: join(commonDir, 'packed-refs') },
    { path: join(commonDir, 'reftable', 'tables.list') }
  ]
  for (const name of entryNames) {
    const entryDir = join(commonDir, 'worktrees', name)
    for (const file of ['HEAD', 'gitdir', 'locked']) {
      dependencies.push({ path: join(entryDir, file) })
    }
  }
  for (const row of rows) {
    if (row.branch && isSafeRefName(row.branch)) {
      dependencies.push({ path: join(commonDir, ...row.branch.split('/')) })
    }
    if (!row.isMainWorktree) {
      dependencies.push({ path: join(row.path, '.git'), noFollow: true })
    }
  }
  return dependencies
}

async function readEntryNames(worktreesDir: string): Promise<string[]> {
  try {
    return await readdir(worktreesDir)
  } catch {
    // Unreadable is not "no entries": an empty list still re-runs Git whenever the stamp moves.
    return []
  }
}

export type GitValidationResult = { state: GitDerivationState; rows: GitWorktreeInfo[] }

/**
 * Re-run Git only when a stat moved, the listing was marked dirty, or the floor is due. Stamps are
 * taken before Git runs. A dependency only the new rows name (a branch that just appeared) is
 * stamped after the listing; a write in that gap is left to Orca's mutation marks and the floor.
 */
export async function validateMembershipFromGit(input: {
  repoPath: string
  commonDir: string
  options: GitWorktreeExecOptions
  previous: GitDerivationState
  previousRows: GitWorktreeInfo[] | null
  mustRun: boolean
  /** How to list when Git must run; defaults to `git worktree list` with the sparse annotation. */
  listRows?: () => Promise<GitWorktreeInfo[]>
}): Promise<GitValidationResult> {
  const { commonDir, previous } = input
  const worktreesDir = join(commonDir, 'worktrees')
  const listingStamp = await readAdminStatStamp({ path: worktreesDir })
  const entryNames =
    previous.entryNames && listingStamp !== null && listingStamp === previous.listingStamp
      ? previous.entryNames
      : await readEntryNames(worktreesDir)
  const dependencies = gitDependencies(commonDir, entryNames, input.previousRows ?? [])
  const before = await readAdminStatSignature(dependencies)
  const unchanged =
    !input.mustRun &&
    input.previousRows !== null &&
    listingStamp !== null &&
    listingStamp === previous.listingStamp &&
    isAdminStatSignatureUnchanged(previous.signature, before)
  if (unchanged && input.previousRows) {
    return { rows: input.previousRows, state: previous }
  }
  const rows = input.listRows
    ? await input.listRows()
    : (await readGitWorktreeRows(input.repoPath, input.options)).rows
  const stampByPath = new Map(
    dependencies.map((dependency, index) => [dependency.path, before[index]])
  )
  const nextDependencies = gitDependencies(commonDir, entryNames, rows)
  const discovered = nextDependencies.filter((dependency) => !stampByPath.has(dependency.path))
  const discoveredStamps = await readAdminStatSignature(discovered)
  discovered.forEach((dependency, index) =>
    stampByPath.set(dependency.path, discoveredStamps[index])
  )
  const signature: AdminStatSignature = nextDependencies.map(
    (dependency) => stampByPath.get(dependency.path) ?? null
  )
  return { rows, state: { entryNames, listingStamp, signature } }
}

/** Main row first, linked rows bytewise by path. */
function inComparableOrder(rows: readonly GitWorktreeInfo[]): GitWorktreeInfo[] {
  const [main, ...linked] = rows
  return [
    main,
    ...linked.sort((left, right) => compareWorktreePathsLikeGit(left.path, right.path, false))
  ]
}

/**
 * The first field where the file rows and Git's rows disagree, or null when they match. `locked`
 * and `prunable` are compared only when Git printed them (the `-z` form, Git >= 2.36); sparse is
 * Orca's own annotation and never in Git's output. Linked-row order is not compared: Git's depends
 * on its build and locale (Apple Git folds Latin-1 case under a UTF-8 locale), so the model's
 * linked-row order is Orca's own and nothing reads it as Git's.
 */
export function describeMembershipParityMismatch(
  unorderedFileRows: readonly GitWorktreeInfo[],
  unorderedGitRows: readonly GitWorktreeInfo[],
  gitPrintsLockAndPrune: boolean
): string | null {
  if (unorderedFileRows.length !== unorderedGitRows.length) {
    return `row count ${unorderedFileRows.length} vs git ${unorderedGitRows.length}`
  }
  const fileRows = inComparableOrder(unorderedFileRows)
  const gitRows = inComparableOrder(unorderedGitRows)
  const fields = ['path', 'head', 'branch', 'isBare', 'isMainWorktree'] as const
  for (let index = 0; index < gitRows.length; index++) {
    const fileRow = fileRows[index]
    const gitRow = gitRows[index]
    for (const field of fields) {
      if (fileRow[field] !== gitRow[field]) {
        return `row ${index} ${field}: ${String(fileRow[field])} vs git ${String(gitRow[field])}`
      }
    }
    if (
      gitPrintsLockAndPrune &&
      (Boolean(fileRow.locked) !== Boolean(gitRow.locked) ||
        (fileRow.lockReason ?? '') !== (gitRow.lockReason ?? '') ||
        Boolean(fileRow.prunable) !== Boolean(gitRow.prunable))
    ) {
      return `row ${index} lock/prunable state differs from git (${gitRow.path})`
    }
  }
  return null
}
