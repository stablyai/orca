// The central audited-worktree drift verifier. Read-only, optional-lock
// suppressed, and used by provisioning, triage entry, reconciliation, and
// recovery so there is exactly one definition of "this worktree is still
// trustworthy".
//
// Phase 3 has NO trusted-commit escape hatch: HEAD must be symbolic on the
// persisted branch, and both HEAD and the branch tip must equal the persisted
// base commit. A later trusted-commit phase will introduce its own explicit
// expected-HEAD policy with its own evidence rather than a boolean that
// disables this invariant.
import { existsSync } from 'node:fs'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import {
  buildRevParseCommitArgv,
  buildSymbolicRefArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { readCommonDir } from './audited-worktree-evidence'
import {
  canonicalizeAllowingMissing,
  isPathInside,
  pathsEqualForHost
} from './audited-worktree-managed-root'

export type DriftVerificationResult =
  | { ok: true }
  | { ok: false; reasonCode: WorktreeReasonCode }

export type DriftVerificationInput = {
  /** The path Git reports for this worktree, or the path being checked. */
  worktreePath: string
  /** The path persisted on the task at finalization. */
  expectedWorktreePath: string
  managedRoot: string
  branchName: string
  baseCommit: string
  sourceRepoCommonDir: string
}

export async function verifyAuditedWorktree(
  input: DriftVerificationInput
): Promise<DriftVerificationResult> {
  const canonicalWorktree = canonicalizeAllowingMissing(input.worktreePath)
  if (!existsSync(canonicalWorktree)) {
    return { ok: false, reasonCode: 'worktree_missing' }
  }

  const canonicalManagedRoot = canonicalizeAllowingMissing(input.managedRoot)
  if (!isPathInside(canonicalWorktree, canonicalManagedRoot)) {
    return { ok: false, reasonCode: 'worktree_path_outside_managed_root' }
  }
  // Canonical-to-canonical, so a drive-letter or 8.3 difference is never
  // reported as drift while a genuine relocation still is.
  if (
    !pathsEqualForHost(canonicalWorktree, canonicalizeAllowingMissing(input.expectedWorktreePath))
  ) {
    return { ok: false, reasonCode: 'worktree_path_mismatch' }
  }

  const commonDir = await readCommonDir(canonicalWorktree)
  if (!commonDir) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }
  if (!pathsEqualForHost(commonDir, canonicalizeAllowingMissing(input.sourceRepoCommonDir))) {
    return { ok: false, reasonCode: 'repository_identity_mismatch' }
  }

  const symbolic = await runAuditedGitRead(buildSymbolicRefArgv(), canonicalWorktree)
  const symbolicRef = symbolic.ok ? symbolic.stdout.trim() : ''
  if (!symbolicRef) {
    // symbolic-ref --quiet exits non-zero on a detached HEAD.
    return { ok: false, reasonCode: 'head_not_symbolic' }
  }
  if (symbolicRef !== `refs/heads/${input.branchName}`) {
    return { ok: false, reasonCode: 'head_branch_mismatch' }
  }

  const head = await runAuditedGitRead(buildRevParseCommitArgv('HEAD'), canonicalWorktree)
  if (!head.ok) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }
  if (head.stdout.trim() !== input.baseCommit) {
    return { ok: false, reasonCode: 'head_moved_from_base_commit' }
  }

  const tip = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${input.branchName}`),
    canonicalWorktree
  )
  if (!tip.ok) {
    return { ok: false, reasonCode: 'worktree_unreadable' }
  }
  if (tip.stdout.trim() !== input.baseCommit) {
    return { ok: false, reasonCode: 'branch_tip_moved_from_base_commit' }
  }

  return { ok: true }
}
