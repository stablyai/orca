// Phases A, B, C, D — the Git side of the two-phase local commit (Phase 8).
//
// PHASE ORDER IS LOAD-BEARING:
//   A  commit-tree            -> object exists, ref still at base, status clean
//   B  update-ref <new> <old> -> the ONE narrowly authorized ref update
//   C  read-tree HEAD         -> reconcile the REAL index with the new HEAD
//   D  re-derive + compare    -> post-commit worktree verification (advisory)
//
// A crash between A and B leaves an unreferenced commit object: inert, gc-able,
// and provably harmless because the ref never moved. That guarantee is the entire
// reason the phases are ordered this way.
//
// Orca's own Git surfaces refuse commits on audited worktrees
// (AUDITED_GIT_MUTATION_OPERATIONS includes 'commit'); this module is the
// sanctioned route the refusal message names, and it never touches the user's
// index except for Phase C's deliberate refresh.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommitReasonCode } from '../../shared/audited-commit-types'
import {
  buildCommitTreeArgv,
  buildReadTreeRefreshArgv,
  buildRevParseCommitArgv,
  buildUpdateRefCasArgv,
  runAuditedGitCommitWrite,
  runAuditedGitRead
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

export type CommitTreeResult =
  | { ok: true; commitSha: string }
  | { ok: false; reasonCode: CommitReasonCode }

function getAttemptTempDir(userDataPath: string, attemptId: string): string {
  return join(userDataPath, 'audited-workflow', 'commit-attempts', attemptId)
}

/**
 * Phase A — create the commit object and nothing else.
 *
 * The message goes through a file, never argv: process listings are
 * world-readable on most platforms and a commit message can carry sensitive
 * context. The temp file is removed in a `finally`.
 */
export async function runCommitTree(args: {
  userDataPath: string
  attemptId: string
  worktreePath: string
  treeOid: string
  parentOid: string
  message: string
}): Promise<CommitTreeResult> {
  const tempDir = getAttemptTempDir(args.userDataPath, args.attemptId)
  const messageFile = join(tempDir, 'message.txt')
  try {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 })
    writeFileSync(messageFile, args.message, { encoding: 'utf8', mode: 0o600 })

    const result = await runAuditedGitCommitWrite(
      buildCommitTreeArgv(args.treeOid, args.parentOid, messageFile),
      args.worktreePath
    )
    if (!result.ok) {
      return { ok: false, reasonCode: 'commit_tree_failed' }
    }
    const commitSha = result.stdout.trim()
    if (!FULL_OID.test(commitSha)) {
      return { ok: false, reasonCode: 'commit_tree_failed' }
    }
    return { ok: true, commitSha }
  } catch (error) {
    console.error('[auditedWorkflow] commit-tree failed:', error)
    return { ok: false, reasonCode: 'commit_tree_failed' }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch (error) {
      // A leftover temp dir is inert and outside the repository.
      console.error('[auditedWorkflow] commit temp cleanup failed:', error)
    }
  }
}

export type RefUpdateResult = { ok: true } | { ok: false; reasonCode: CommitReasonCode }

/**
 * Phase B — the compare-and-swap ref update.
 *
 * The three-operand form fails loudly if the branch moved under us, which is the
 * only concurrency guarantee Git itself provides here. It says nothing about
 * filesystem edits — that is Phase D's job.
 */
export async function runRefUpdateCas(args: {
  worktreePath: string
  branchName: string
  newCommitSha: string
  expectedOldSha: string
}): Promise<RefUpdateResult> {
  const result = await runAuditedGitCommitWrite(
    buildUpdateRefCasArgv(args.branchName, args.newCommitSha, args.expectedOldSha),
    args.worktreePath
  )
  if (!result.ok) {
    // A CAS rejection and a genuine write failure are indistinguishable from the
    // exit code alone, so the caller classifies from evidence rather than trust.
    return { ok: false, reasonCode: 'branch_ref_moved' }
  }
  return { ok: true }
}

/**
 * Phase C — reconcile the REAL index with the new HEAD.
 *
 * Verified necessary: without it `git status` reports spurious MM/D entries,
 * because the index still describes the pre-commit state. Index-only — no
 * worktree file is written, and both tracked and untracked files stay
 * byte-intact.
 *
 * Returns false rather than throwing: the commit is already durable, so a
 * refresh failure is an ADVISORY, never a commit failure.
 */
export async function runIndexRefresh(worktreePath: string): Promise<boolean> {
  const result = await runAuditedGitCommitWrite(buildReadTreeRefreshArgv(), worktreePath)
  return result.ok
}

/** Reads the current tip of a branch, for Phase B's expected-old and Phase D. */
export async function readBranchTip(
  worktreePath: string,
  branchName: string
): Promise<string | null> {
  const result = await runAuditedGitRead(
    buildRevParseCommitArgv(`refs/heads/${branchName}`),
    worktreePath
  )
  if (!result.ok) {
    return null
  }
  const oid = result.stdout.trim()
  return FULL_OID.test(oid) ? oid : null
}

/** Reads HEAD's commit, used by post-commit verification. */
export async function readHeadCommit(worktreePath: string): Promise<string | null> {
  const result = await runAuditedGitRead(buildRevParseCommitArgv('HEAD'), worktreePath)
  if (!result.ok) {
    return null
  }
  const oid = result.stdout.trim()
  return FULL_OID.test(oid) ? oid : null
}
