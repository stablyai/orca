// Classifies six-channel evidence into exactly one recovery decision. Shared by
// provisioning (after a failed or crashed `git worktree add`) and by startup
// reconciliation, so both make identical judgements about the same on-disk state.
//
// Adoption requires EVERY channel to match; anything partial is ambiguous and is
// never remediated automatically.
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import type { AuditedWorktreeAttemptRow } from './audited-worktree-attempt-repository'
import { isAllEvidenceAbsent, type AuditedWorktreeEvidence } from './audited-worktree-evidence'
import { deriveProvenanceId } from './audited-worktree-identity'
import { canonicalizeAllowingMissing, pathsEqualForHost } from './audited-worktree-managed-root'

export type EvidenceClassification =
  /** Git provably did nothing: safe to release the path and retry. */
  | { kind: 'all_absent' }
  /** Every channel matches the claim exactly: adopt idempotently. */
  | { kind: 'exact_full_creation' }
  /** Anything else: block, keep guarded, never clean. */
  | { kind: 'ambiguous'; reasonCode: WorktreeReasonCode }

export type ClassificationInput = {
  attempt: AuditedWorktreeAttemptRow
  evidence: AuditedWorktreeEvidence
  taskId: string
  repoId: string
}

export function classifyEvidence(input: ClassificationInput): EvidenceClassification {
  const { attempt, evidence } = input

  if (isAllEvidenceAbsent(evidence)) {
    return { kind: 'all_absent' }
  }

  // A directory that exists but is not a Git worktree is never adoptable and is
  // reported distinctly, since the remedy differs from generic ambiguity.
  if (evidence.pathIsNonWorktree) {
    return { kind: 'ambiguous', reasonCode: 'worktree_path_occupied' }
  }

  const canonicalIntended = canonicalizeAllowingMissing(attempt.intendedPath)
  const matchesProvenance =
    evidence.commonDir !== null &&
    deriveProvenanceId({
      taskId: input.taskId,
      repoId: input.repoId,
      canonicalCommonDir: evidence.commonDir,
      baseCommit: attempt.intendedBaseCommit,
      branchName: attempt.intendedBranch,
      canonicalWorktreePath: canonicalIntended
    }) === attempt.provenanceId

  const exact =
    evidence.pathExists &&
    evidence.branchExists &&
    evidence.registered &&
    !evidence.registrationPrunable &&
    evidence.adminRecordExists &&
    evidence.branchTip === attempt.intendedBaseCommit &&
    evidence.headCommit === attempt.intendedBaseCommit &&
    evidence.headSymbolicRef === `refs/heads/${attempt.intendedBranch}` &&
    evidence.commonDir !== null &&
    pathsEqualForHost(evidence.commonDir, canonicalizeAllowingMissing(attempt.intendedCommonDir)) &&
    matchesProvenance

  if (exact) {
    return { kind: 'exact_full_creation' }
  }

  // Branch-only, registration-only, partial directory, moved tip, common-dir or
  // provenance mismatch — all collapse here. The user is never offered an
  // automatic fix, and no Git state is touched.
  return { kind: 'ambiguous', reasonCode: 'provision_evidence_ambiguous' }
}
