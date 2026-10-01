import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { PromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import { readTranslatedWorktreeGraph } from '../worktree-list-reader'
import { isNotGitRepositoryError, type GitWorktreeExecOptions } from '../worktree-operation-options'
import {
  isAdminStatSignatureUnchanged,
  readAdminStatSignature,
  type AdminStatDependency,
  type AdminStatSignature
} from './admin-stat-signature'
import {
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  MEMBERSHIP_IDLE_DROP_MS
} from './worktree-membership-model'

// A registered folder that exists but that Git says is not a repository (its `.git` deleted, an
// unmounted volume's mount point). Git's answer is kept and re-checked by stat, as a missing repo
// path is, instead of running `git worktree list` on every read.

type NotRepositoryVerdict = {
  /** Git's own error, so every reader classifies it exactly as when Git answered. */
  error: unknown
  signature: AdminStatSignature
  checkedAt: number
  /** The stat check running now, shared by concurrent readers. */
  check: PromiseSettlementWaiters<boolean> | null
}

const verdicts = new Map<string, NotRepositoryVerdict>()

// Where `git init`, a restored `.git` file or directory, or an in-place bare init shows up.
function verdictDependencies(repoPath: string): AdminStatDependency[] {
  return [{ path: repoPath }, { path: join(repoPath, '.git'), noFollow: true }]
}

/** A folder files cannot place in a repository, with the stamps a verdict on it would keep. */
export type UnplacedRepo = { unplacedStamps: AdminStatSignature }

/** Taken by the model build, under its readers' deadlines, before Git is asked about the folder. */
export async function stampUnplacedRepo(repoPath: string): Promise<UnplacedRepo> {
  return { unplacedStamps: await readAdminStatSignature(verdictDependencies(repoPath)) }
}

/**
 * Git's listing for a folder files cannot place; a "not a git repository" answer is kept with the
 * stamps taken before Git ran, so a repository appearing during the run is seen by the next read.
 */
export async function readWithoutModel(
  key: string,
  repoPath: string,
  { unplacedStamps: signature }: UnplacedRepo,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[]> {
  try {
    return await readTranslatedWorktreeGraph(repoPath, options)
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      verdicts.set(key, { error, signature, checkedAt: Date.now(), check: null })
    }
    throw error
  }
}

/**
 * Git's error when its verdict still stands, else null and the verdict is dropped. The floor
 * covers what no stamp shows: a parent directory becoming a repository, or the environment.
 */
export async function readNotRepositoryVerdict(
  key: string,
  repoPath: string,
  wait: (check: PromiseSettlementWaiters<boolean>) => Promise<boolean>
): Promise<{ error: unknown } | null> {
  const verdict = verdicts.get(key)
  if (!verdict) {
    return null
  }
  if (Date.now() - verdict.checkedAt < MEMBERSHIP_FULL_DERIVE_FLOOR_MS) {
    if (!verdict.check) {
      const stamps = readAdminStatSignature(verdictDependencies(repoPath))
      verdict.check = new PromiseSettlementWaiters(
        stamps.then((current) => isAdminStatSignatureUnchanged(verdict.signature, current)),
        () => {
          verdict.check = null
        }
      )
    }
    if (await wait(verdict.check)) {
      return { error: verdict.error }
    }
  }
  if (verdicts.get(key) === verdict) {
    verdicts.delete(key)
  }
  return null
}

/** Drops verdicts nobody re-checked for the idle window, or whose folder is not registered. */
export function dropNotRepositoryVerdicts(now: number, registeredKeys?: ReadonlySet<string>): void {
  for (const [key, verdict] of verdicts) {
    if (now - verdict.checkedAt >= MEMBERSHIP_IDLE_DROP_MS || registeredKeys?.has(key) === false) {
      verdicts.delete(key)
    }
  }
}

export function _resetNotRepositoryVerdictsForTests(): void {
  verdicts.clear()
}
