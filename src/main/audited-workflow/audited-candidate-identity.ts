// Computes the CANDIDATE TREE OID: the content identity of the implemented work
// (Phase 7).
//
// WHY NOT HEAD. verifyAuditedWorktree requires HEAD and the branch tip to both
// equal base_commit, with no trusted-commit escape hatch — so audited work is
// always UNCOMMITTED working-tree content. Its identity cannot come from HEAD,
// and a diff is unusable as identity because its bytes vary with Git version and
// config. `git write-tree` produces a stable OID computed by Git itself.
//
// WHY THE OBJECT DIRECTORY IS REDIRECTED, NOT JUST THE INDEX. GIT_INDEX_FILE
// isolates only the index. `git add -A` still hashes working-tree content and
// `git write-tree` still writes real blob/tree objects — so with a temp index
// ALONE, the bytes of uncommitted and untracked non-ignored files are persisted
// into the user's .git/objects, where they survive until an eventual gc.
// Measured: object count 3 -> 5, and `git cat-file -p <hash>` printed the
// contents of an untracked file. That is a durable side effect on the user's
// repository and this feature must not introduce one.
//
// So all three variables are set together:
//   GIT_INDEX_FILE                   -> per-run temp index
//   GIT_OBJECT_DIRECTORY             -> per-run temp object dir (ALL writes)
//   GIT_ALTERNATE_OBJECT_DIRECTORIES -> the real common object dir, READ-ONLY
// Verified in the real deployment shape (linked worktree, one modified tracked
// file, one untracked file): real objects 3 -> 3 unchanged, 3 new objects in the
// temp dir, identical tree OID, `git status` unaffected.
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCandidateAddArgv,
  buildReadTreeArgv,
  buildRevParseTreeArgv,
  buildWriteTreeArgv,
  runAuditedGitCandidateWrite,
  runAuditedGitRead,
  type CandidateIsolationBounds,
  type CandidateIsolationEnv
} from './audited-worktree-commands'
import { readCommonDir } from './audited-worktree-evidence'
import { FULL_OID } from './audited-worktree-identity'
import type { CandidateReasonCode } from '../../shared/audited-code-audit-types'

export type CandidateDerivationResult =
  | {
      ok: true
      treeOid: string
      /**
       * The object directory holding the derived graph. For 'ephemeral' this is
       * already deleted by the time the caller sees it and is reported only for
       * logging; for 'durable' it is the retained store the promoter reads.
       */
      objectDir: string
    }
  | { ok: false; reasonCode: CandidateReasonCode }

/**
 * Whether the derived objects survive the call (Phase 8 §0).
 *
 * `ephemeral` is Phase 7's original behavior and stays the default for every
 * VERIFICATION derivation — admission re-checks, the A0.1 freshness gate, and
 * Phase D. Those must leave nothing behind, which is what keeps a drift mismatch
 * from persisting the very bytes it is checking.
 *
 * `durable` retains the objects under an app-owned store so Phase 8 can later
 * promote the approved graph into the real store instead of re-hashing the
 * worktree. Used ONLY when a run is producing the candidate attachCandidate will
 * record.
 */
export type CandidateRetention = 'ephemeral' | 'durable'

export type DeriveCandidateArgs = {
  runId: string
  userDataPath: string
  worktreePath: string
  /** The repo whose object store backs the worktree. */
  sourceRepoPath: string
  baseCommit: string
  /** Non-null means a non-local execution host. */
  wslDistro: string | null
  hostId: string
  /** Defaults to 'ephemeral' — Phase 7's behavior is never changed implicitly. */
  retention?: CandidateRetention
  /**
   * Where durable objects land. Required when retention is 'durable'; the
   * candidate id keys the directory so it shares the candidate's lifecycle.
   */
  durableStoreDir?: string
  /**
   * Invoked with the object dir while it still EXISTS, before an ephemeral
   * cleanup runs. This is how §0.2 measures a completed fact: whatever Git
   * hashed is the candidate, and its footprint is read here rather than guessed
   * beforehand by a filesystem preflight.
   */
  onDerived?: (objectDir: string, treeOid: string) => Promise<void>
}

export function getCandidateRunDir(userDataPath: string, runId: string): string {
  return join(userDataPath, 'audited-workflow', 'candidates', runId)
}

// Mirrors PLAN_ARTIFACT_ID_PATTERN: the shape a sweep uses to decide whether a
// directory could ever have been produced by this module. Anything else is left
// strictly alone.
export const CANDIDATE_RUN_DIR_PATTERN = /^exec_[0-9a-f]{16}$/

/**
 * Derives the candidate tree OID, or returns a closed reason code.
 *
 * The per-run directory — index, index.lock, and every object Git created — is
 * removed in a `finally`. Nothing downstream needs those objects: the candidate
 * IS the 40-hex string, and the audit re-derives rather than re-reading.
 */
export async function deriveCandidateTree(
  args: DeriveCandidateArgs
): Promise<CandidateDerivationResult> {
  // Fail closed on non-local hosts. addWslEnvKeys forwards a variable NAME, so
  // under WSL these paths would have to be Linux-side, and the audited workflow
  // has no path translation today. Refusing is honest; guessing would produce a
  // wrong OID that every downstream guard would then trust.
  if (args.wslDistro !== null || args.hostId !== 'local') {
    return { ok: false, reasonCode: 'candidate_host_unsupported' }
  }
  if (!FULL_OID.test(args.baseCommit)) {
    return { ok: false, reasonCode: 'candidate_path_unsupported' }
  }

  // The existing resolver: tries --path-format=absolute (Git >= 2.31), detects
  // old Git echoing the unknown flag, falls back to the bare 2.25-compatible
  // form, and normalizes a relative result. Phase 7 adds no new Git option and
  // no new capability entry — there is exactly one definition of "where is this
  // repo's object store".
  const commonDir = await readCommonDir(args.sourceRepoPath)
  if (!commonDir) {
    return { ok: false, reasonCode: 'candidate_path_unsupported' }
  }
  const commonObjectDir = join(commonDir, 'objects')

  // A durable derivation keeps its objects under the app-owned candidate store;
  // an ephemeral one uses the per-run temp dir and deletes it in the `finally`.
  // The ISOLATION SHAPE IS IDENTICAL either way — temp index, redirected object
  // dir, real store attached read-only — so a durable derivation is still
  // incapable of writing into .git/objects. Only the destination and the
  // lifetime differ.
  const retention: CandidateRetention = args.retention ?? 'ephemeral'
  const candidateDir =
    retention === 'durable' && args.durableStoreDir
      ? args.durableStoreDir
      : getCandidateRunDir(args.userDataPath, args.runId)
  const isolation: CandidateIsolationEnv = {
    gitIndexFile: join(candidateDir, 'index.tmp'),
    gitObjectDirectory: join(candidateDir, 'objects'),
    gitAlternateObjectDirectories: commonObjectDir
  }
  const bounds: CandidateIsolationBounds = {
    candidateDir,
    worktreePath: args.worktreePath,
    commonObjectDir
  }

  try {
    // Git creates fanout subdirectories itself, but the root must exist.
    mkdirSync(isolation.gitObjectDirectory, { recursive: true })

    const seeded = await runAuditedGitCandidateWrite(
      buildReadTreeArgv(args.baseCommit),
      args.worktreePath,
      isolation,
      bounds
    )
    if (!seeded.ok) {
      return { ok: false, reasonCode: 'candidate_derivation_failed' }
    }

    const staged = await runAuditedGitCandidateWrite(
      buildCandidateAddArgv(),
      args.worktreePath,
      isolation,
      bounds
    )
    if (!staged.ok) {
      return { ok: false, reasonCode: 'candidate_derivation_failed' }
    }

    const written = await runAuditedGitCandidateWrite(
      buildWriteTreeArgv(),
      args.worktreePath,
      isolation,
      bounds
    )
    if (!written.ok) {
      return { ok: false, reasonCode: 'candidate_derivation_failed' }
    }

    const treeOid = written.stdout.trim()
    if (!FULL_OID.test(treeOid)) {
      return { ok: false, reasonCode: 'candidate_derivation_failed' }
    }

    // An empty change set means the implementation produced nothing. Auditing it
    // would let Codex approve work that changes no file, so it blocks instead.
    // Read through the ordinary read path — rev-parse creates no object.
    const baseTree = await runAuditedGitRead(
      buildRevParseTreeArgv(args.baseCommit),
      args.worktreePath
    )
    if (baseTree.ok && baseTree.stdout.trim() === treeOid) {
      return { ok: false, reasonCode: 'empty_change_set' }
    }

    // Measured while the objects still exist — §0.2 judges a completed fact, not
    // a preflight prediction. Runs before the `finally` deletes an ephemeral dir.
    if (args.onDerived) {
      await args.onDerived(isolation.gitObjectDirectory, treeOid)
    }

    return { ok: true, treeOid, objectDir: isolation.gitObjectDirectory }
  } catch (error) {
    // Includes the isolation shape errors, which are programming errors — logged
    // locally, reported as a closed code, never surfaced as text.
    console.error('[auditedWorkflow] Candidate derivation failed:', error)
    return { ok: false, reasonCode: 'candidate_derivation_failed' }
  } finally {
    // A durable derivation KEEPS its objects: Phase 8 promotes the approved graph
    // from them rather than re-hashing the worktree. Its temp index is still
    // removed — only the object dir needs to survive.
    try {
      if (retention === 'durable') {
        rmSync(isolation.gitIndexFile, { force: true })
      } else {
        rmSync(candidateDir, { recursive: true, force: true })
      }
    } catch (error) {
      // A leftover directory is inert: it is outside the repository and nothing
      // references it. Losing the delete must never change an outcome.
      console.error('[auditedWorkflow] Candidate temp cleanup failed:', error)
    }
  }
}
