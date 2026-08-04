// Phase 8 Git surface: the commit-protocol builders and the two spawn policies
// that surround them.
//
// Split from audited-worktree-commands.ts so that file stays within its line
// budget without a max-lines suppression; the allowlist and the structural argv
// screen still live there and are applied to every command built here.
//
// THE TWO POLICIES BELOW ARE INVERSES, and stating both explicitly is what stops
// them from ever being confused:
//   assertCandidateIsolation  REQUIRES a temp object dir (leave no trace)
//   assertCommitWriteIsolation FORBIDS one               (the commit must persist)
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../git/runner'
import {
  assertAuditedGitArgvShape,
  findGitSubcommand,
  AuditedGitCommandShapeError,
  CANDIDATE_FORBIDDEN_OPTIONS,
  CANDIDATE_STORE_READ_SUBCOMMANDS,
  COMMIT_WRITE_SUBCOMMANDS,
  type AuditedGitResult
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

// ─── Phase 8 builders ───────────────────────────────────────────────

/**
 * Enumerates the approved object graph. Walks OBJECTS, never the filesystem, so a
 * concurrently edited or newly created worktree file cannot be included.
 */
export function buildRevListObjectsArgv(treeOid: string): string[] {
  if (!FULL_OID.test(treeOid)) {
    throw new AuditedGitCommandShapeError('tree oid must be a full 40-hex OID')
  }
  return ['rev-list', '--objects', '--no-object-names', treeOid]
}

/** Packs exactly the OIDs fed on stdin; `--stdout` so nothing is written to disk. */
export function buildPackObjectsStdoutArgv(): string[] {
  return ['pack-objects', '--stdout']
}

/** Unpacks a pack stream into the object store selected by the caller's env. */
export function buildUnpackObjectsArgv(): string[] {
  return ['unpack-objects']
}

/** Existence probe; creates nothing. */
export function buildCatFileExistsArgv(oid: string): string[] {
  return ['cat-file', '-e', oid]
}

/** Object type probe, used by commit-attempt evidence. */
export function buildCatFileTypeArgv(oid: string): string[] {
  return ['cat-file', '-t', oid]
}

/** Pretty-prints a commit object so its message/parent/tree can be verified. */
export function buildCatFileCommitArgv(oid: string): string[] {
  return ['cat-file', 'commit', oid]
}

/** Descendant probe for `committed_sha_not_descendant_of_base`. */
export function buildRevListCountArgv(from: string, to: string): string[] {
  return ['rev-list', '--count', `${from}..${to}`]
}

/**
 * Phase A: the commit object. Reads the message from a file so no message byte
 * ever appears in argv (process listings are world-readable on most platforms).
 */
export function buildCommitTreeArgv(
  treeOid: string,
  parentOid: string,
  messageFile: string
): string[] {
  if (!FULL_OID.test(treeOid) || !FULL_OID.test(parentOid)) {
    throw new AuditedGitCommandShapeError('commit-tree requires full 40-hex OIDs')
  }
  return ['commit-tree', treeOid, '-p', parentOid, '-F', messageFile]
}

/**
 * Phase B: the ONE narrowly authorized ref update, in the three-operand
 * compare-and-swap form. The expected-old operand is what makes a moved branch a
 * loud failure rather than a silent overwrite.
 */
export function buildUpdateRefCasArgv(
  branch: string,
  newOid: string,
  expectedOldOid: string
): string[] {
  if (!FULL_OID.test(newOid) || !FULL_OID.test(expectedOldOid)) {
    throw new AuditedGitCommandShapeError('update-ref requires full 40-hex OIDs')
  }
  return ['update-ref', `refs/heads/${branch}`, newOid, expectedOldOid]
}

/** Phase C: reconciles the REAL index with the new HEAD. Index-only. */
export function buildReadTreeRefreshArgv(): string[] {
  return ['read-tree', 'HEAD']
}

/**
 * Screens a commit-write spawn (Phase 8).
 *
 * THE INVERSE OF assertCandidateIsolation, and deliberately so. That function
 * REQUIRES a temp object dir because a candidate must leave no trace; this one
 * FORBIDS one because the commit and the promoted graph must persist. Asserting
 * both explicitly is what stops the two policies from ever being confused.
 */
export function assertCommitWriteIsolation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined
): void {
  for (const option of CANDIDATE_FORBIDDEN_OPTIONS) {
    if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
      throw new AuditedGitCommandShapeError(
        `${option} is never permitted on a commit command: it would re-point Git`
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
    // Phase C only: the bare `read-tree HEAD` refresh. A tree-ish operand here
    // could stage arbitrary content into the user's real index.
    const treeIndex = argv.indexOf('read-tree')
    const rest = argv.slice(treeIndex)
    if (rest.length !== 2 || rest[1] !== 'HEAD') {
      throw new AuditedGitCommandShapeError(
        'commit-path read-tree must be exactly `read-tree HEAD`'
      )
    }
  }

  // The real store is the destination, so any redirection must be absent.
  if (env?.GIT_OBJECT_DIRECTORY || env?.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    throw new AuditedGitCommandShapeError(
      'commit commands must write the real object store: GIT_OBJECT_DIRECTORY must be unset'
    )
  }
}

/**
 * Runs one commit-protocol command against the REAL object store.
 *
 * Optional-lock suppression is kept so nothing rewrites .git/index behind our
 * back; Phase C's `read-tree HEAD` is the single deliberate index write and is
 * screened above.
 */
export async function runAuditedGitCommitWrite(
  argv: readonly string[],
  cwd: string,
  options?: { stdin?: string }
): Promise<AuditedGitResult> {
  assertAuditedGitArgvShape(argv)
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !COMMIT_WRITE_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(
      `runAuditedGitCommitWrite is only for commit commands, got: ${subcommand ?? '<none>'}`
    )
  }
  const env = gitOptionalLocksDisabledEnv()
  assertCommitWriteIsolation(argv, env)
  try {
    const { stdout } = await gitExecFileAsync([...argv], {
      cwd,
      env,
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {})
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Runs one read-only command against the APP-OWNED candidate store (Phase 8
 * A0.2).
 *
 * GIT_OBJECT_DIRECTORY is REQUIRED and must name the candidate store: that is
 * what makes "promotion reads objects, never the worktree" a structural
 * guarantee rather than a convention. Neither admissible subcommand can write to
 * the real store.
 */
export function assertCandidateStoreReadShape(
  argv: readonly string[],
  candidateStoreDir: string
): void {
  assertAuditedGitArgvShape(argv)
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !CANDIDATE_STORE_READ_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(
      `candidate store reads are only rev-list/pack-objects, got: ${subcommand ?? '<none>'}`
    )
  }
  if (!candidateStoreDir) {
    throw new AuditedGitCommandShapeError('candidate store reads require the store directory')
  }
  if (subcommand === 'pack-objects' && !argv.includes('--stdout')) {
    throw new AuditedGitCommandShapeError(
      'pack-objects must be --stdout: it may never write a pack'
    )
  }
  for (const option of CANDIDATE_FORBIDDEN_OPTIONS) {
    if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
      throw new AuditedGitCommandShapeError(
        `${option} is never permitted on a candidate store read: it would re-point Git`
      )
    }
  }
}
