// Reads the Git evidence channels used by land-attempt crash recovery (Phase 10).
//
// Why channels rather than a status column: a non-zero exit is NOT proof Git made
// no durable change, and a crash leaves no exit code at all. The only honest way
// to decide what happened is to look at the refs and trees Git actually holds and
// compare them to what the attempt row said was INTENDED.
//
// READ-ONLY, and deliberately so: recovery classifies, it never remediates.
import { existsSync } from 'node:fs'
import type { LandAttemptRow } from './audited-land-attempt-repository'
import {
  buildDiffIndexQuietArgv,
  buildRevListCountArgv,
  buildRevParseCommitArgv,
  buildStatusPorcelainArgv,
  runAuditedGitRead
} from './audited-worktree-commands'
import { readCommonDir } from './audited-worktree-evidence'
import { canonicalizeAllowingMissing, pathsEqualForHost } from './audited-worktree-managed-root'
import { FULL_OID } from './audited-worktree-identity'

export type LandEvidence = {
  /** L0: the source repo still exists and is the SAME repository. */
  repoIdentityIntact: boolean
  /** L1: where the source branch points now, or null when unreadable. */
  branchTip: string | null
  /** L2: the source repo's HEAD commit, or null when unreadable. */
  headCommit: boolean
  /** L3: commits in intended_sha not reachable from the tip; 0 means present. */
  committedMissingFromTip: number | null
  /** L4: whether the working tree is clean (index and files match HEAD). */
  worktreeClean: boolean
  /** Whether any evidence read failed outright — forces ambiguity. */
  unreadable: boolean
}

export async function readLandEvidence(attempt: LandAttemptRow): Promise<LandEvidence> {
  const repoPath = canonicalizeAllowingMissing(attempt.sourceRepoPath)
  if (!existsSync(repoPath)) {
    return {
      repoIdentityIntact: false,
      branchTip: null,
      headCommit: false,
      committedMissingFromTip: null,
      worktreeClean: false,
      unreadable: true
    }
  }

  // Identity first: a different repository at the same path makes every other
  // channel meaningless, and reporting a "landed" tip from it would be a lie.
  const commonDir = await readCommonDir(repoPath)
  const repoIdentityIntact =
    commonDir !== null &&
    pathsEqualForHost(commonDir, canonicalizeAllowingMissing(attempt.sourceRepoCommonDir))

  const tipResult = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${attempt.intendedBranch}`),
    repoPath
  )
  const branchTip =
    tipResult.ok && FULL_OID.test(tipResult.stdout.trim()) ? tipResult.stdout.trim() : null

  const headResult = await runAuditedGitRead(buildRevParseCommitArgv('HEAD'), repoPath)
  const headCommit = headResult.ok && headResult.stdout.trim() === attempt.intendedSha

  let committedMissingFromTip: number | null = null
  if (branchTip !== null) {
    const counted = await runAuditedGitRead(
      buildRevListCountArgv(branchTip, attempt.intendedSha),
      repoPath
    )
    if (counted.ok) {
      const value = Number.parseInt(counted.stdout.trim(), 10)
      committedMissingFromTip = Number.isFinite(value) ? value : null
    }
  }

  const status = await runAuditedGitRead(buildStatusPorcelainArgv(), repoPath)
  const staged = await runAuditedGitRead(buildDiffIndexQuietArgv('HEAD'), repoPath)
  const worktreeClean = status.ok && status.stdout.trim().length === 0 && staged.ok

  return {
    repoIdentityIntact,
    branchTip,
    headCommit,
    committedMissingFromTip,
    worktreeClean,
    unreadable: !tipResult.ok
  }
}
