// L0 — source-repository identity, readiness, and tip classification (Phase 10).
//
// READ-ONLY. Every function here runs against the user's SOURCE repository and
// none of them can mutate it: the module imports no land-write builder and no
// spawn policy other than runAuditedGitRead.
//
// This is the gate that decides whether a fast-forward is even representable.
// Because landing writes the user's own working tree, every check is a REFUSAL,
// never a warning — a "probably fine" here would corrupt a workspace Orca does
// not own.
import { existsSync } from 'node:fs'
import { parseWorktreeList } from '../git/worktree'
import type { LandingReasonCode } from '../../shared/audited-workflow-types'
import {
  buildDiffIndexQuietArgv,
  buildRevListCountArgv,
  buildRevParseCommitArgv,
  buildStatusPorcelainArgv,
  buildSymbolicRefArgv,
  buildWorktreeListArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { readCommonDir } from './audited-worktree-evidence'
import { canonicalizeAllowingMissing, pathsEqualForHost } from './audited-worktree-managed-root'
import { FULL_OID } from './audited-worktree-identity'

export type SourceRepoCheck = { ok: true } | { ok: false; reasonCode: LandingReasonCode }

/**
 * Identity: the path exists AND its common dir is the one recorded on the task.
 *
 * The common-dir comparison is what makes this IDENTITY rather than location — a
 * path can be deleted and recreated as a different repository, and landing into
 * that would apply audited work to a repo nobody approved.
 */
export async function verifySourceRepoIdentity(args: {
  sourceRepoPath: string
  sourceRepoCommonDir: string
}): Promise<SourceRepoCheck> {
  const canonical = canonicalizeAllowingMissing(args.sourceRepoPath)
  if (!existsSync(canonical)) {
    return { ok: false, reasonCode: 'source_repo_missing' }
  }
  const commonDir = await readCommonDir(canonical)
  if (!commonDir) {
    return { ok: false, reasonCode: 'source_repo_missing' }
  }
  if (!pathsEqualForHost(commonDir, canonicalizeAllowingMissing(args.sourceRepoCommonDir))) {
    return { ok: false, reasonCode: 'source_repo_mismatch' }
  }
  return { ok: true }
}

/**
 * Readiness: HEAD is symbolic on the expected branch and the tree is clean.
 *
 * Cleanliness is checked TWICE by different means because they catch different
 * things: `status --porcelain` sees untracked and unstaged changes, while
 * `diff-index --quiet HEAD` catches staged mode/content differences that a clean
 * status can still hide. `read-tree -m -u` would refuse on either, so failing
 * closed here turns a confusing mid-protocol abort into an actionable refusal.
 */
export async function verifySourceRepoReadiness(args: {
  sourceRepoPath: string
  branchName: string
}): Promise<SourceRepoCheck> {
  const symbolic = await runAuditedGitRead(buildSymbolicRefArgv(), args.sourceRepoPath)
  if (!symbolic.ok) {
    // symbolic-ref --quiet exits non-zero on a detached HEAD.
    return { ok: false, reasonCode: 'source_repo_detached_or_invalid_branch' }
  }
  if (symbolic.stdout.trim() !== `refs/heads/${args.branchName}`) {
    return { ok: false, reasonCode: 'source_repo_detached_or_invalid_branch' }
  }

  const status = await runAuditedGitRead(buildStatusPorcelainArgv(), args.sourceRepoPath)
  if (!status.ok) {
    return { ok: false, reasonCode: 'source_repo_missing' }
  }
  if (status.stdout.trim().length > 0) {
    return { ok: false, reasonCode: 'source_repo_dirty' }
  }

  const staged = await runAuditedGitRead(buildDiffIndexQuietArgv('HEAD'), args.sourceRepoPath)
  if (!staged.ok) {
    return { ok: false, reasonCode: 'source_repo_dirty' }
  }
  return { ok: true }
}

/**
 * The branch must be checked out AT THE RECORDED SOURCE REPO PATH.
 *
 * A branch held by a DIFFERENT worktree is refused rather than landed into:
 * moving the ref under a worktree Orca is not updating would leave that
 * worktree's index and HEAD describing a commit its files no longer match. Git
 * itself refuses `git checkout` for the same reason.
 */
export async function verifyBranchCheckedOutHere(args: {
  sourceRepoPath: string
  branchName: string
}): Promise<SourceRepoCheck> {
  const listed = await runAuditedGitRead(buildWorktreeListArgv(), args.sourceRepoPath)
  if (!listed.ok) {
    return { ok: false, reasonCode: 'landing_evidence_ambiguous' }
  }
  const canonicalSource = canonicalizeAllowingMissing(args.sourceRepoPath)
  const wanted = `refs/heads/${args.branchName}`
  const holder = parseWorktreeList(listed.stdout).find((entry) => entry.branch === wanted)
  if (!holder) {
    return { ok: false, reasonCode: 'source_repo_branch_not_checked_out' }
  }
  if (!pathsEqualForHost(canonicalizeAllowingMissing(holder.path), canonicalSource)) {
    return { ok: false, reasonCode: 'source_repo_branch_not_checked_out' }
  }
  return { ok: true }
}

export type TipClassification =
  // The branch sits exactly at the recorded base: a clean fast-forward.
  | { kind: 'fast_forward'; tip: string }
  // The work is ALREADY present in the source branch's history — either exactly
  // at the committed sha or at a descendant of it. Idempotent adopt.
  | { kind: 'already_landed'; tip: string }
  | { kind: 'refused'; reasonCode: LandingReasonCode }

/**
 * Classifies where the source branch tip sits relative to base and committed.
 *
 * The three outcomes are genuinely different and must never collapse:
 *   - at base            -> we may fast-forward
 *   - at/after committed -> the work is already there; adopt, do not mutate
 *   - anything else      -> refuse, because a merge decision belongs to a human
 */
export async function classifySourceRepoTip(args: {
  sourceRepoPath: string
  branchName: string
  baseCommit: string
  committedSha: string
}): Promise<TipClassification> {
  const tipResult = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${args.branchName}`),
    args.sourceRepoPath
  )
  if (!tipResult.ok) {
    return { kind: 'refused', reasonCode: 'landing_evidence_ambiguous' }
  }
  const tip = tipResult.stdout.trim()
  if (!FULL_OID.test(tip)) {
    return { kind: 'refused', reasonCode: 'landing_evidence_ambiguous' }
  }

  if (tip === args.committedSha) {
    return { kind: 'already_landed', tip }
  }
  if (tip === args.baseCommit) {
    return { kind: 'fast_forward', tip }
  }

  // Is the committed sha already an ancestor of the tip? `committed..tip` counts
  // commits reachable from tip but not from committed; `tip..committed` counting
  // zero is what proves committed is an ANCESTOR rather than merely related.
  const behind = await countRange(args.sourceRepoPath, tip, args.committedSha)
  if (behind === null) {
    return { kind: 'refused', reasonCode: 'landing_evidence_ambiguous' }
  }
  if (behind === 0) {
    // Nothing in committed is missing from tip: the work is present in history.
    return { kind: 'already_landed', tip }
  }

  // The tip carries commits the audited work does not build on. Whether that is
  // a stale checkout or a genuine divergence decides the code.
  const ahead = await countRange(args.sourceRepoPath, args.baseCommit, tip)
  if (ahead === null) {
    return { kind: 'refused', reasonCode: 'landing_evidence_ambiguous' }
  }
  if (ahead === 0) {
    // tip is at or behind base — the checkout is stale, not divergent.
    return { kind: 'refused', reasonCode: 'source_repo_not_at_base_commit' }
  }
  // tip has commits beyond base that the audited commit does not contain: a real
  // merge or rebase is required, and this lane will never attempt one.
  return { kind: 'refused', reasonCode: 'integration_required' }
}

/** `rev-list --count <from>..<to>`; null when unreadable. */
async function countRange(repoPath: string, from: string, to: string): Promise<number | null> {
  const counted = await runAuditedGitRead(buildRevListCountArgv(from, to), repoPath)
  if (!counted.ok) {
    return null
  }
  const value = Number.parseInt(counted.stdout.trim(), 10)
  return Number.isFinite(value) ? value : null
}
