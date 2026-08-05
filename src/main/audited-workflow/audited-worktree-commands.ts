// The ONLY module that spawns Git for audited worktrees. Every command is built
// by a fixed constructor and screened by a STRUCTURAL parser — not a substring
// blacklist, which would wrongly reject a repo path containing "remote".
//
// Network-free by construction.
//
// WHAT MUTATES WHAT (Phase 7 correction). `worktree add` remains the only command
// that mutates the user's repository. Candidate derivation (read-tree/add/
// write-tree) writes objects too, but ONLY into a per-run temporary object
// directory selected by GIT_OBJECT_DIRECTORY; the real object store is attached
// read-only as a single alternate so the base commit still resolves. No ref is
// created, the real index is never opened, and the temp directory is deleted when
// derivation ends.
//
// That isolation is enforced HERE, at the spawn boundary, not merely arranged by
// the caller: runAuditedGitCandidateWrite refuses to spawn unless the env proves
// it. A missing GIT_OBJECT_DIRECTORY is precisely the bug that would silently
// persist uncommitted and untracked file bytes into .git/objects, so it is a hard
// refusal rather than a default.
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../git/runner'
import { FULL_OID } from './audited-worktree-identity'
import { canonicalizeAllowingMissing, isPathInside } from './audited-worktree-managed-root'
import {
  assertReadProbeShape,
  isRevListCountArgv,
  EXACT_FORM_READ_SUBCOMMANDS
} from './audited-read-probe-shapes'

const ALLOWED_SUBCOMMANDS = new Set([
  'worktree',
  'rev-parse',
  'symbolic-ref',
  'show-ref',
  'cat-file',
  // Phase 7 candidate identity. Admissible ONLY through
  // runAuditedGitCandidateWrite, which enforces the temp-index + temp-object-dir
  // isolation; runAuditedGitRead rejects them via isReadOnlyAuditedArgv.
  'read-tree',
  'add',
  'write-tree',
  // Phase 8. commit-tree/update-ref are admissible ONLY through
  // runAuditedGitCommitWrite; rev-list/pack-objects ONLY through
  // runAuditedGitCandidateStoreRead. unpack-objects writes into the real store
  // and is likewise commit-write-only.
  'commit-tree',
  'update-ref',
  'rev-list',
  'pack-objects',
  'unpack-objects',
  // Phase 9. The ONLY network subcommands, admissible ONLY through
  // runAuditedGitPublish. `fetch`, `pull`, `clone`, and `submodule` remain
  // rejected — see the network-free note above, which now holds for every path
  // EXCEPT the narrowly screened publish one.
  'push',
  'ls-remote',
  // Read-only remote topology, needed to resolve the push target truthfully.
  'config',
  'remote',
  // Phase 10. Read-only source-repo readiness probes, admitted ONLY in the exact
  // canonical forms screened by arity below. Both are network-free and neither
  // writes: `status --porcelain` reports, and `diff-index --quiet` compares.
  'status',
  'diff-index',
  // The no-tools audit bundle. `diff-tree` rather than `diff`: it never consults
  // the index or worktree. Two exact forms only — see assertDiffTreeShape.
  'diff-tree'
])
const ALLOWED_WORKTREE_VERBS = new Set(['add', 'list'])

// Phase 9. The two network subcommands, admissible ONLY through
// runAuditedGitPublish. Kept separate from the allowlist so the read path and the
// publish path can be told apart structurally rather than by convention.
export const PUBLISH_NETWORK_SUBCOMMANDS = new Set(['push', 'ls-remote'])

// Phase 9 read-only remote topology. `config` is admitted ONLY in the
// `config --get <key>` form and `remote` ONLY as the bare listing form: every
// other shape (`--add`, `--unset`, `remote add|set-url|update|prune`) either
// mutates configuration or reaches the network, so both are screened by arity
// below rather than trusted.
const REMOTE_TOPOLOGY_SUBCOMMANDS = new Set(['config', 'remote'])

// The three subcommands that may create Git objects. Kept separate from the
// allowlist so the read path and the candidate path can be told apart
// structurally rather than by convention.
const CANDIDATE_SUBCOMMANDS = new Set(['read-tree', 'add', 'write-tree'])

// Phase 8. Subcommands that may run against the REAL object store, admissible
// only through runAuditedGitCommitWrite.
//
// `add` and `write-tree` are DELIBERATELY EXCLUDED: they hash working-tree files,
// and the whole point of the promotion design is that no such command ever runs
// against the real store. Their only legitimate use is inside deriveCandidateTree,
// which has its own enforced temp-object-dir isolation.
export const COMMIT_WRITE_SUBCOMMANDS = new Set([
  'unpack-objects',
  'commit-tree',
  'update-ref',
  'read-tree'
])

// Phase 8. Read-only enumeration/packing against the app-owned candidate store.
// Neither can write to the real store: pack-objects is --stdout-only and rev-list
// creates nothing.
export const CANDIDATE_STORE_READ_SUBCOMMANDS = new Set(['rev-list', 'pack-objects'])

// Options that would let an argv re-point Git at a different index, object store,
// worktree, or repository — defeating the env-based isolation.
export const CANDIDATE_FORBIDDEN_OPTIONS = [
  '--index-file',
  '-C',
  '--work-tree',
  '--git-dir',
  '--namespace'
]

// Global options that consume a following operand, so the parser can find the
// real subcommand by arity rather than by guessing.
const VALUE_TAKING_GLOBALS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace'])

export class AuditedGitCommandShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditedGitCommandShapeError'
  }
}

/**
 * Finds the actual Git subcommand by skipping global options by arity.
 * Handles `-c k=v`, `-ck=v`, `--git-dir=<v>`, and the separated forms.
 */
export function findGitSubcommand(argv: readonly string[]): string | null {
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (!token.startsWith('-')) {
      return token
    }
    if (VALUE_TAKING_GLOBALS.has(token)) {
      index += 2
      continue
    }
    // Attached forms (-c k=v as -ck=v, --git-dir=/x) carry their value inline.
    index += 1
  }
  return null
}

/**
 * Runtime screen applied before every spawn — not test-only. Rejects any argv
 * whose real subcommand is outside the allowlist, any worktree verb other than
 * add/list, and any use of -B (which would reset an existing branch).
 */
export function assertAuditedGitArgvShape(argv: readonly string[]): void {
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(`disallowed git subcommand: ${subcommand ?? '<none>'}`)
  }
  if (subcommand === 'worktree') {
    const verbIndex = argv.indexOf('worktree') + 1
    const verb = argv[verbIndex]
    if (!verb || !ALLOWED_WORKTREE_VERBS.has(verb)) {
      throw new AuditedGitCommandShapeError(`disallowed worktree verb: ${verb ?? '<none>'}`)
    }
  }
  // Every remaining arity screen — Phase 9's read-only remote topology and Phase
  // 10's readiness probes — lives in audited-read-probe-shapes.ts so this file
  // stays within its max-lines budget.
  assertReadProbeShape(argv, subcommand)
  if (argv.includes('-B')) {
    throw new AuditedGitCommandShapeError('-B is never permitted: it resets an existing branch')
  }
}

export function isReadOnlyAuditedArgv(argv: readonly string[]): boolean {
  const subcommand = findGitSubcommand(argv)
  if (subcommand === 'worktree') {
    return argv[argv.indexOf('worktree') + 1] === 'list'
  }
  if (subcommand !== null && CANDIDATE_SUBCOMMANDS.has(subcommand)) {
    // These create objects. They are admissible, but never through the read path.
    return false
  }
  // Phase 8: commit-tree/unpack-objects create objects and update-ref mutates a
  // ref, so none may reach the read path. rev-list/pack-objects create nothing,
  // but they need the candidate store attached via GIT_OBJECT_DIRECTORY, which
  // only runAuditedGitCandidateStoreRead supplies — so they are excluded here too
  // rather than silently running against the wrong store.
  if (subcommand !== null && COMMIT_WRITE_SUBCOMMANDS.has(subcommand)) {
    return false
  }
  if (subcommand !== null && CANDIDATE_STORE_READ_SUBCOMMANDS.has(subcommand)) {
    // EXCEPT `rev-list --count <a>..<b>`, which is a pure ancestry probe: it
    // creates nothing, enumerates no object contents, and resolves entirely from
    // the REAL store, so it needs no GIT_OBJECT_DIRECTORY. The candidate-store
    // form is `rev-list --objects`, which does. Phase 8's commit evidence and
    // Phase 10's tip classification both depend on the counting form reaching the
    // read path; screening by the flag rather than the subcommand is what keeps
    // the enumerating form off it.
    return isRevListCountArgv(argv)
  }
  // Phase 9: `push` mutates a remote ref and `ls-remote` reaches the network, so
  // neither may reach the read path, which applies no lease screen and no
  // BatchMode env. runAuditedGitPublish is the only admissible route.
  if (subcommand !== null && PUBLISH_NETWORK_SUBCOMMANDS.has(subcommand)) {
    return false
  }
  // `config --get` / bare `remote` genuinely are read-only and network-free once
  // screened above, so they stay on the read path.
  if (subcommand !== null && REMOTE_TOPOLOGY_SUBCOMMANDS.has(subcommand)) {
    return true
  }
  // Phase 10's `status --porcelain` / `diff-index --quiet` and the audit
  // bundle's `diff-tree` are all genuinely read-only ONCE SCREENED BY ARITY
  // above, so they stay on the read path. The land WRITE subcommands
  // (update-ref/read-tree) are already excluded by COMMIT_WRITE_SUBCOMMANDS.
  if (subcommand !== null && EXACT_FORM_READ_SUBCOMMANDS.has(subcommand)) {
    return true
  }
  return subcommand !== null && ALLOWED_SUBCOMMANDS.has(subcommand)
}

export function buildReadTreeArgv(baseCommit: string): string[] {
  if (!FULL_OID.test(baseCommit)) {
    throw new AuditedGitCommandShapeError('base commit must be a full 40-hex OID')
  }
  return ['read-tree', baseCommit]
}

/**
 * Exactly `add -A --`: stage the whole worktree, no pathspec.
 *
 * The absent pathspec is deliberate — it is what removes the path-traversal
 * surface entirely rather than trying to validate one.
 */
export function buildCandidateAddArgv(): string[] {
  return ['add', '-A', '--']
}

export function buildWriteTreeArgv(): string[] {
  return ['write-tree']
}

/** `<base>^{tree}`, used to detect an empty change set. */
export function buildRevParseTreeArgv(rev: string): string[] {
  return ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`]
}

// Suppress auto-maintenance so provisioning cannot trigger background gc/prefetch.
// Global -c options precede the subcommand, per the repo's Git-compatibility rule.
const NO_MAINTENANCE = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0']

export function buildWorktreeAddArgv(
  branch: string,
  worktreePath: string,
  baseCommit: string
): string[] {
  if (!FULL_OID.test(baseCommit)) {
    throw new AuditedGitCommandShapeError('base commit must be a full 40-hex OID')
  }
  return [
    ...NO_MAINTENANCE,
    'worktree',
    'add',
    '--no-track',
    '-b',
    branch,
    worktreePath,
    baseCommit
  ]
}

export function buildRevParseCommitArgv(rev: string): string[] {
  return ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]
}

export function buildGitCommonDirArgv(): string[] {
  return ['rev-parse', '--path-format=absolute', '--git-common-dir']
}

export function buildGitCommonDirFallbackArgv(): string[] {
  return ['rev-parse', '--git-common-dir']
}

export function buildSymbolicRefArgv(): string[] {
  return ['symbolic-ref', '--quiet', 'HEAD']
}

export function buildWorktreeListArgv(): string[] {
  return ['worktree', 'list', '--porcelain']
}

export function buildShowRefArgv(branch: string): string[] {
  return ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]
}

export type AuditedGitResult = { ok: true; stdout: string } | { ok: false; error: unknown }

/**
 * Runs a read-only audited Git command with optional-lock suppression, so
 * verification and reconciliation never rewrite .git/index.
 */
export async function runAuditedGitRead(
  argv: readonly string[],
  cwd: string
): Promise<AuditedGitResult> {
  assertAuditedGitArgvShape(argv)
  // A candidate command routed through the READ path would run with no
  // GIT_OBJECT_DIRECTORY and write straight into the real object store — the
  // exact failure this phase exists to prevent. Refuse structurally.
  if (!isReadOnlyAuditedArgv(argv)) {
    throw new AuditedGitCommandShapeError(
      'candidate commands must use runAuditedGitCandidateWrite, not the read path'
    )
  }
  try {
    const { stdout } = await gitExecFileAsync([...argv], {
      cwd,
      env: gitOptionalLocksDisabledEnv()
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * The complete env a candidate-write command must run under. Every field is
 * required: the isolation is only sound if all three are present together.
 */
export type CandidateIsolationEnv = {
  /** Per-run temp index. The real .git/index is never opened. */
  gitIndexFile: string
  /** Per-run temp object dir. ALL newly created objects land here. */
  gitObjectDirectory: string
  /** Exactly one entry: the real common object dir, attached read-only. */
  gitAlternateObjectDirectories: string
}

export type CandidateIsolationBounds = {
  /** The per-run directory both temp paths must live inside. */
  candidateDir: string
  /** The audited worktree — neither temp path may be inside it. */
  worktreePath: string
  /** The real common object dir — the ONLY legal alternate value. */
  commonObjectDir: string
}

/**
 * Screens a candidate-write spawn. Throws rather than returning a result: a
 * violation here is a programming error that must never reach Git, not a runtime
 * condition a caller could sensibly recover from.
 */
export function assertCandidateIsolation(
  argv: readonly string[],
  env: CandidateIsolationEnv,
  bounds: CandidateIsolationBounds
): void {
  for (const option of CANDIDATE_FORBIDDEN_OPTIONS) {
    if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
      throw new AuditedGitCommandShapeError(
        `${option} is never permitted on a candidate command: it would defeat the env isolation`
      )
    }
  }

  const subcommand = findGitSubcommand(argv)
  if (subcommand === 'add') {
    // Exactly `add -A --`. Any extra token would be a pathspec.
    const addIndex = argv.indexOf('add')
    const rest = argv.slice(addIndex)
    if (rest.length !== 3 || rest[1] !== '-A' || rest[2] !== '--') {
      throw new AuditedGitCommandShapeError('candidate add must be exactly `add -A --`')
    }
  }

  if (!env.gitIndexFile || !env.gitObjectDirectory || !env.gitAlternateObjectDirectories) {
    throw new AuditedGitCommandShapeError(
      'candidate commands require GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, and GIT_ALTERNATE_OBJECT_DIRECTORIES'
    )
  }

  // Both temp paths must be inside the per-run directory and outside the
  // worktree. Checking containment in the candidate dir is the positive form;
  // the worktree check catches a candidate dir that was itself misconfigured.
  for (const [label, value] of [
    ['GIT_INDEX_FILE', env.gitIndexFile],
    ['GIT_OBJECT_DIRECTORY', env.gitObjectDirectory]
  ] as const) {
    const canonical = canonicalizeAllowingMissing(value)
    if (!isPathInside(canonical, canonicalizeAllowingMissing(bounds.candidateDir))) {
      throw new AuditedGitCommandShapeError(`${label} must live inside the per-run candidate dir`)
    }
    if (isPathInside(canonical, canonicalizeAllowingMissing(bounds.worktreePath))) {
      throw new AuditedGitCommandShapeError(`${label} must not live inside the audited worktree`)
    }
  }

  // The alternate names the real object store and nothing else. A list would let
  // an unexpected store satisfy a read, and GIT_ALTERNATE_OBJECT_DIRECTORIES is
  // PATH-separator-delimited, so a path containing the separator is ambiguous.
  const alternate = env.gitAlternateObjectDirectories
  const separator = process.platform === 'win32' ? ';' : ':'
  const withoutDriveColon =
    process.platform === 'win32' ? alternate.replace(/^[A-Za-z]:/, '') : alternate
  if (withoutDriveColon.includes(separator)) {
    throw new AuditedGitCommandShapeError(
      'GIT_ALTERNATE_OBJECT_DIRECTORIES must be exactly one entry'
    )
  }
  if (
    !isPathInside(
      canonicalizeAllowingMissing(alternate),
      canonicalizeAllowingMissing(bounds.commonObjectDir)
    )
  ) {
    throw new AuditedGitCommandShapeError(
      'GIT_ALTERNATE_OBJECT_DIRECTORIES must be the repository common object dir'
    )
  }
}

/**
 * Runs one candidate-identity command under enforced isolation.
 *
 * Optional-lock suppression is kept so nothing rewrites .git/index, and the three
 * isolation variables are applied LAST so a caller-supplied env can never
 * override them.
 */
export async function runAuditedGitCandidateWrite(
  argv: readonly string[],
  cwd: string,
  env: CandidateIsolationEnv,
  bounds: CandidateIsolationBounds
): Promise<AuditedGitResult> {
  assertAuditedGitArgvShape(argv)
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !CANDIDATE_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(
      `runAuditedGitCandidateWrite is only for candidate commands, got: ${subcommand ?? '<none>'}`
    )
  }
  assertCandidateIsolation(argv, env, bounds)

  try {
    const { stdout } = await gitExecFileAsync([...argv], {
      cwd,
      env: {
        ...gitOptionalLocksDisabledEnv(),
        GIT_INDEX_FILE: env.gitIndexFile,
        GIT_OBJECT_DIRECTORY: env.gitObjectDirectory,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: env.gitAlternateObjectDirectories
      }
    })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * The single command that mutates the user's repository. Returns a result rather
 * than throwing: a non-zero exit is NOT proof Git made no durable change, so the
 * caller must run full evidence classification before choosing a status.
 */
export async function runAuditedWorktreeAdd(
  argv: readonly string[],
  cwd: string
): Promise<AuditedGitResult> {
  assertAuditedGitArgvShape(argv)
  try {
    const { stdout } = await gitExecFileAsync([...argv], { cwd })
    return { ok: true, stdout }
  } catch (error) {
    return { ok: false, error }
  }
}

// Phase 8's builders and its two extra spawn policies live in their own module so
// this file stays within its line budget; re-exported so every audited Git call
// site still imports from one place.
export * from './audited-commit-commands'
// Phase 9's builders and the single network spawn policy, likewise.
export * from './audited-publish-commands'
// Phase 10's builders and the single source-repo spawn policy, likewise.
export * from './audited-land-commands'
