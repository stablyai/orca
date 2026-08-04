// Phase 10 Git surface: the land-protocol builders and the ONE spawn policy that
// surrounds them.
//
// Split from audited-worktree-commands.ts so that file stays within its line
// budget without a max-lines suppression; the allowlist and the structural argv
// screen still live there and are applied to every command built here.
//
// THE FOUR WRITE POLICIES, STATED TOGETHER so they can never be confused:
//   assertCandidateIsolation   REQUIRES a temp object dir (leave no trace)
//   assertCommitWriteIsolation FORBIDS one; read-tree must be exactly `read-tree HEAD`
//   assertLandWriteIsolation   FORBIDS one; read-tree must be exactly `read-tree -m -u A B`
//   (publish has no object-store policy at all — it is the network path)
//
// AND THE ONE INVERSION THAT IS UNIQUE TO THIS MODULE: every other audited Git
// path runs INSIDE the managed worktree. This one runs inside the user's SOURCE
// repository and refuses to spawn against an audited worktree at all. That is the
// structural guarantee that a landing command can never mutate the managed tree.
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../git/runner'
import {
  assertAuditedGitArgvShape,
  findGitSubcommand,
  AuditedGitCommandShapeError,
  CANDIDATE_FORBIDDEN_OPTIONS,
  type AuditedGitResult
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'
import { isAuditedWorktreePath, isAuditedWorktreeRegistryReady } from './audited-worktree-registry'

// The two subcommands admissible through runAuditedGitLandWrite. Deliberately a
// SUBSET of COMMIT_WRITE_SUBCOMMANDS: `unpack-objects` and `commit-tree` create
// objects, and landing creates nothing — every object it references was already
// promoted into the real store by Phase 8.
export const LAND_WRITE_SUBCOMMANDS = new Set(['update-ref', 'read-tree'])

// ─── Phase 10 builders ──────────────────────────────────────────────

/** Source-repo cleanliness: any output at all means dirty. */
export function buildStatusPorcelainArgv(): string[] {
  return ['status', '--porcelain']
}

/**
 * Staged-vs-<tree-ish> comparison. Complements `status --porcelain`: status can
 * report a clean tree while the index still differs in mode/content edge cases.
 */
export function buildDiffIndexQuietArgv(treeish: string): string[] {
  return ['diff-index', '--quiet', treeish, '--']
}

/**
 * L3: move the index AND the working tree from <from> to <to>.
 *
 * `-m` makes this a two-way merge that REFUSES rather than clobbering when a file
 * changed under us; `-u` is what propagates the result to the working tree. Both
 * operands are full OIDs so no ref lookup can redirect the operation.
 *
 * NOT admissible on the commit path: assertCommitWriteIsolation pins read-tree to
 * exactly `read-tree HEAD`, and widening that would let arbitrary content be
 * staged into a user's real index. This form is land-path-only.
 */
export function buildLandReadTreeArgv(fromOid: string, toOid: string): string[] {
  if (!FULL_OID.test(fromOid) || !FULL_OID.test(toOid)) {
    throw new AuditedGitCommandShapeError('land read-tree requires full 40-hex OIDs')
  }
  return ['read-tree', '-m', '-u', fromOid, toOid]
}

/**
 * Screens a land-write spawn (Phase 10).
 *
 * Throws rather than returning a result: a violation here is a programming error
 * that must never reach Git, not a runtime condition a caller could recover from.
 */
export function assertLandWriteIsolation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  cwd: string
): void {
  for (const option of CANDIDATE_FORBIDDEN_OPTIONS) {
    if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
      throw new AuditedGitCommandShapeError(
        `${option} is never permitted on a land command: it would re-point Git`
      )
    }
  }

  const subcommand = findGitSubcommand(argv)
  if (subcommand === 'update-ref') {
    // Exactly three operands: <ref> <new> <old>. A two-operand form is a blind
    // overwrite, and -d/--stdin would delete or batch-edit refs.
    if (argv.includes('-d') || argv.includes('--stdin')) {
      throw new AuditedGitCommandShapeError('update-ref -d/--stdin is never permitted')
    }
    const refIndex = argv.indexOf('update-ref')
    if (argv.slice(refIndex).length !== 4) {
      throw new AuditedGitCommandShapeError(
        'update-ref must use the three-operand compare-and-swap form'
      )
    }
  }
  if (subcommand === 'read-tree') {
    // Exactly `read-tree -m -u <from> <to>`. Any other arity or flag set could
    // reset the index to an arbitrary tree or skip the -m safety check.
    const treeIndex = argv.indexOf('read-tree')
    const rest = argv.slice(treeIndex)
    if (
      rest.length !== 5 ||
      rest[1] !== '-m' ||
      rest[2] !== '-u' ||
      !FULL_OID.test(rest[3]) ||
      !FULL_OID.test(rest[4])
    ) {
      throw new AuditedGitCommandShapeError(
        'land-path read-tree must be exactly `read-tree -m -u <oid> <oid>`'
      )
    }
  }

  // The real store is the destination, so any redirection must be absent. Landing
  // creates no object, but a redirected store would make the referenced commit
  // unresolvable and could leave the ref pointing at nothing.
  if (env?.GIT_OBJECT_DIRECTORY || env?.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    throw new AuditedGitCommandShapeError(
      'land commands must use the real object store: GIT_OBJECT_DIRECTORY must be unset'
    )
  }

  // THE INVERSION. Fail closed while the registry is still loading: membership is
  // unknowable until both durable sources have loaded, and a land command is
  // exactly the mutation that must never guess.
  if (!isAuditedWorktreeRegistryReady()) {
    throw new AuditedGitCommandShapeError(
      'land commands cannot run before the audited worktree registry is ready'
    )
  }
  if (isAuditedWorktreePath(cwd)) {
    throw new AuditedGitCommandShapeError(
      'land commands must run in the source repository, never an audited worktree'
    )
  }
}

/**
 * Runs one land-protocol command against the user's SOURCE repository.
 *
 * Optional-lock suppression is kept for consistency with the other paths; note it
 * does NOT suppress the deliberate index write that `read-tree -m -u` performs,
 * which is the whole point of L3.
 */
export async function runAuditedGitLandWrite(
  argv: readonly string[],
  cwd: string
): Promise<AuditedGitResult> {
  assertAuditedGitArgvShape(argv)
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !LAND_WRITE_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(
      `runAuditedGitLandWrite is only for land commands, got: ${subcommand ?? '<none>'}`
    )
  }
  const env = gitOptionalLocksDisabledEnv()
  assertLandWriteIsolation(argv, env, cwd)
  try {
    const { stdout } = await gitExecFileAsync([...argv], { cwd, env })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error }
  }
}
