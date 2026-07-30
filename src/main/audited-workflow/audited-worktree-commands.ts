// The ONLY module that spawns Git for audited worktrees. Every command is built
// by a fixed constructor and screened by a STRUCTURAL parser — not a substring
// blacklist, which would wrongly reject a repo path containing "remote".
//
// Network-free by construction: the sole mutating shape is `worktree add` with a
// full 40-hex base OID (never a ref name, so no ref resolution or implicit
// prefetch) and --no-track (so no upstream is configured to later pull from).
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../git/runner'
import { FULL_OID } from './audited-worktree-identity'

const ALLOWED_SUBCOMMANDS = new Set(['worktree', 'rev-parse', 'symbolic-ref', 'show-ref', 'cat-file'])
const ALLOWED_WORKTREE_VERBS = new Set(['add', 'list'])

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
  if (argv.includes('-B')) {
    throw new AuditedGitCommandShapeError('-B is never permitted: it resets an existing branch')
  }
}

export function isReadOnlyAuditedArgv(argv: readonly string[]): boolean {
  const subcommand = findGitSubcommand(argv)
  if (subcommand === 'worktree') {
    return argv[argv.indexOf('worktree') + 1] === 'list'
  }
  return subcommand !== null && ALLOWED_SUBCOMMANDS.has(subcommand)
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
  return [...NO_MAINTENANCE, 'worktree', 'add', '--no-track', '-b', branch, worktreePath, baseCommit]
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
 * The single mutating command in the feature. Returns a result rather than
 * throwing: a non-zero exit is NOT proof Git made no durable change, so the
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
