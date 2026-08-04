// Phase A0 — making the approved tree resolvable in the REAL object store.
//
// WHY THIS EXISTS AT ALL. Phase 7 derived the candidate under a temp
// GIT_OBJECT_DIRECTORY and deleted it, so at commit time `git commit-tree <tree>`
// dies with "not a valid object". Something must put the approved graph back.
//
// WHAT IT MUST NOT DO. Re-deriving into the real store would hash CURRENT
// worktree bytes and only then compare OIDs — so a mismatch would leave
// unapproved changed and untracked bytes durably in .git/objects, recreating the
// exact leak Phase 7's isolation exists to prevent. "No ref moved" is not "no
// bytes persisted".
//
// THE ORDERING IS THE WHOLE DESIGN:
//   A0.1 verify in a THROWAWAY store  -> a mismatch persists nothing
//   A0.2 promote only approved objects -> reads objects, never the worktree
import type Database from '../sqlite/sync-database'
import type { CommitReasonCode } from '../../shared/audited-commit-types'
import { deriveCandidateTree } from './audited-candidate-identity'
import {
  approvedTreeResolvesInRealStore,
  getCandidateStoreDir,
  promoteApprovedGraph
} from './audited-candidate-object-store'
import { markPromotionStarted, recordVerifiedTree } from './audited-commit-attempt-repository'

export type PromotionPhaseResult = { ok: true } | { ok: false; reasonCode: CommitReasonCode }

export type PromotionPhaseArgs = {
  attemptId: string
  candidateId: string
  approvedTreeOid: string
  userDataPath: string
  worktreePath: string
  sourceRepoPath: string
  baseCommit: string
  wslDistro: string | null
  hostId: string
}

/**
 * Runs A0.1 then A0.2.
 *
 * No SQLite transaction is open across any Git call here; the small evidence
 * writes are individually atomic.
 */
export async function promoteApprovedCandidate(
  db: Database.Database,
  args: PromotionPhaseArgs
): Promise<PromotionPhaseResult> {
  // ---- A0.1 — freshness gate, in a THROWAWAY object store. ----
  // Uses the ordinary ephemeral derivation, so a mismatch deletes everything it
  // wrote and adds ZERO objects to the real store. This is the property a
  // re-derive-into-real-store design cannot provide.
  const verified = await deriveCandidateTree({
    runId: `${args.attemptId}_verify`,
    userDataPath: args.userDataPath,
    worktreePath: args.worktreePath,
    sourceRepoPath: args.sourceRepoPath,
    baseCommit: args.baseCommit,
    wslDistro: args.wslDistro,
    hostId: args.hostId,
    retention: 'ephemeral'
  })
  if (!verified.ok) {
    if (verified.reasonCode === 'candidate_host_unsupported') {
      return { ok: false, reasonCode: 'commit_host_unsupported' }
    }
    return { ok: false, reasonCode: 'materialization_failed' }
  }

  recordVerifiedTree(db, args.attemptId, verified.treeOid)

  // THE GATE. A worktree edited mid-flight produces a different OID, so this
  // refuses before any promotion or commit-tree. Verified experimentally: on
  // mismatch the real object count is unchanged.
  if (verified.treeOid !== args.approvedTreeOid) {
    return { ok: false, reasonCode: 'materialized_tree_mismatch' }
  }

  // ---- A0.2 — promote, reading objects only. ----
  const candidateStoreDir = getCandidateStoreDir(args.userDataPath, args.candidateId)

  // Set BEFORE the first object moves, so a crash mid-promotion is classifiable.
  markPromotionStarted(db, args.attemptId)

  const promoted = await promoteApprovedGraph({
    candidateStoreDir,
    worktreePath: args.worktreePath,
    approvedTreeOid: args.approvedTreeOid
  })
  if (!promoted.ok) {
    return { ok: false, reasonCode: promoted.reasonCode }
  }

  // Prove the graph actually resolves before commit-tree is attempted.
  if (!(await approvedTreeResolvesInRealStore(args.worktreePath, args.approvedTreeOid))) {
    return { ok: false, reasonCode: 'promoted_tree_unresolvable' }
  }

  return { ok: true }
}
