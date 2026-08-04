// Phase 9 Git surface: the ONLY audited path that touches the network.
//
// Split from audited-worktree-commands.ts so that file stays within its line
// budget without a max-lines suppression; the allowlist and the structural argv
// screen still live there and are applied to every command built here.
//
// THE RELAXATION IS DELIBERATELY NARROW. Every other audited spawn path is
// network-free, and `fetch`, `pull`, `clone`, `remote`, and `submodule` REMAIN
// rejected outright. Only `push` and `ls-remote` are admitted, and only through
// runAuditedGitPublish, whose screen enforces:
//
//   - exactly one explicit --force-with-lease=<ref>:<expected>. A BARE lease is
//     rejected: it leases against the local remote-tracking ref, so a background
//     fetch can silently re-arm it and clobber work the user never saw. Supplying
//     the expected value ourselves is what makes the safety check independent of
//     any stale local state.
//   - a refspec whose source is a full 40-hex SHA, never HEAD. A worktree that
//     moves mid-protocol therefore still publishes exactly the audited commit.
//   - no --force, and no destructive push flags.
//
// A violation THROWS rather than returning a result: it is a programming error
// that must never reach Git, not a runtime condition a caller could recover from.
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../git/runner'
import {
  assertAuditedGitArgvShape,
  findGitSubcommand,
  AuditedGitCommandShapeError,
  CANDIDATE_FORBIDDEN_OPTIONS,
  PUBLISH_NETWORK_SUBCOMMANDS
} from './audited-worktree-commands'
import { FULL_OID } from './audited-worktree-identity'

// Push options that would publish or delete refs beyond the single authorized
// branch. Rejected structurally, not by convention.
const FORBIDDEN_PUSH_OPTIONS = [
  '--mirror',
  '--all',
  '--tags',
  '--follow-tags',
  '--delete',
  '-d',
  '--prune',
  '--recurse-submodules',
  '--exec',
  '--receive-pack'
]

// A Git remote name. Deliberately strict: no path separators, no leading dash
// (which would parse as an option), no whitespace.
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/
// A branch name segment set. `check-ref-format` is the authority at runtime; this
// is the shape screen that keeps an option or a refspec separator out of argv.
const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

function assertRemoteName(remote: string): void {
  if (!REMOTE_NAME.test(remote)) {
    throw new AuditedGitCommandShapeError('remote name has an unsupported shape')
  }
}

function assertBranchName(branch: string): void {
  if (!BRANCH_NAME.test(branch) || branch.includes('..') || branch.endsWith('.lock')) {
    throw new AuditedGitCommandShapeError('branch name has an unsupported shape')
  }
}

/**
 * Reads one remote ref. The ONLY network command the recovery paths may build.
 *
 * Creates nothing and mutates nothing, which is what lets both the startup sweep
 * and the user-triggered recheck run it without any risk of a second push.
 */
export function buildLsRemoteArgv(remote: string, branch: string): string[] {
  assertRemoteName(remote)
  assertBranchName(branch)
  // Deliberately NOT --exit-code: that flag makes a missing ref exit non-zero,
  // which would make absence indistinguishable from a transport failure. The
  // plain form exits 0 for BOTH a present and a missing ref, so absence is read
  // from empty stdout and a non-zero exit means only "we could not look".
  return ['ls-remote', '--', remote, `refs/heads/${branch}`]
}

/**
 * The ONE network mutation, in the explicit compare-and-swap form.
 *
 * `expectedRemoteSha === null` means "expected absent" and produces the
 * create-only empty lease (`--force-with-lease=refs/heads/<b>:`), which Git
 * rejects if a branch appeared at that name in the meantime.
 *
 * The source of the refspec is the SHA, never HEAD.
 */
export function buildLeasedPushArgv(args: {
  remote: string
  branch: string
  sha: string
  expectedRemoteSha: string | null
}): string[] {
  assertRemoteName(args.remote)
  assertBranchName(args.branch)
  if (!FULL_OID.test(args.sha)) {
    throw new AuditedGitCommandShapeError('push source must be a full 40-hex OID')
  }
  if (args.expectedRemoteSha !== null && !FULL_OID.test(args.expectedRemoteSha)) {
    throw new AuditedGitCommandShapeError('push lease must be a full 40-hex OID or absent')
  }
  const ref = `refs/heads/${args.branch}`
  return [
    'push',
    `--force-with-lease=${ref}:${args.expectedRemoteSha ?? ''}`,
    '--',
    args.remote,
    `${args.sha}:${ref}`
  ]
}

/** Reads the configured push remote for a branch. Read-only, network-free. */
export function buildRemoteNameConfigArgv(key: string): string[] {
  if (!/^[A-Za-z0-9.<>_-]+$/.test(key)) {
    throw new AuditedGitCommandShapeError('config key has an unsupported shape')
  }
  return ['config', '--get', key]
}

/** Lists configured remotes, so a missing origin is a truthful refusal. */
export function buildRemoteListArgv(): string[] {
  return ['remote']
}

/**
 * Reads a symref (e.g. `refs/remotes/origin/HEAD`) to resolve a base branch.
 *
 * Network-free: this reads what the clone recorded locally, never the remote.
 */
export function buildSymbolicRefQuietArgv(ref: string): string[] {
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
    throw new AuditedGitCommandShapeError('symbolic-ref target has an unsupported shape')
  }
  return ['symbolic-ref', '--quiet', ref]
}

/**
 * Screens a publish spawn (Phase 9).
 *
 * Exported so the boundary test can drive it directly with hand-built argv —
 * the structural guarantees below must hold for ANY argv, not merely for what
 * the builders above happen to produce.
 */
export function assertPublishNetworkShape(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined
): void {
  const subcommand = findGitSubcommand(argv)
  if (subcommand === null || !PUBLISH_NETWORK_SUBCOMMANDS.has(subcommand)) {
    throw new AuditedGitCommandShapeError(
      `runAuditedGitPublish is only for network commands, got: ${subcommand ?? '<none>'}`
    )
  }

  for (const option of CANDIDATE_FORBIDDEN_OPTIONS) {
    if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
      throw new AuditedGitCommandShapeError(
        `${option} is never permitted on a publish command: it would re-point Git`
      )
    }
  }

  if (subcommand === 'push') {
    for (const option of FORBIDDEN_PUSH_OPTIONS) {
      if (argv.some((token) => token === option || token.startsWith(`${option}=`))) {
        throw new AuditedGitCommandShapeError(`${option} is never permitted on a publish push`)
      }
    }
    // A blind force is structurally unrepresentable here.
    if (argv.includes('--force') || argv.includes('-f')) {
      throw new AuditedGitCommandShapeError(
        '--force is never permitted: the publish push must be lease-protected'
      )
    }
    // A BARE --force-with-lease leases against the local remote-tracking ref,
    // which a background fetch can silently re-arm. Only the explicit form,
    // whose expected value we supply, is admissible.
    if (argv.includes('--force-with-lease')) {
      throw new AuditedGitCommandShapeError(
        'a bare --force-with-lease is never permitted: the expected value must be explicit'
      )
    }
    const leases = argv.filter((token) => token.startsWith('--force-with-lease='))
    if (leases.length !== 1) {
      throw new AuditedGitCommandShapeError(
        'the publish push must carry exactly one explicit --force-with-lease=<ref>:<expected>'
      )
    }
    const leaseValue = leases[0].slice('--force-with-lease='.length)
    const separator = leaseValue.indexOf(':')
    if (separator <= 0) {
      throw new AuditedGitCommandShapeError(
        '--force-with-lease must name a ref and an expected value'
      )
    }
    const leaseRef = leaseValue.slice(0, separator)
    const leaseExpected = leaseValue.slice(separator + 1)
    if (!leaseRef.startsWith('refs/heads/')) {
      throw new AuditedGitCommandShapeError('--force-with-lease must lease a refs/heads/ ref')
    }
    // Empty is the deliberate create-only form; anything else must be a full OID.
    if (leaseExpected !== '' && !FULL_OID.test(leaseExpected)) {
      throw new AuditedGitCommandShapeError(
        '--force-with-lease expected value must be a full 40-hex OID or empty'
      )
    }

    // Exactly one refspec, sourced from a full OID and targeting the leased ref.
    const separatorIndex = argv.indexOf('--')
    if (separatorIndex === -1) {
      throw new AuditedGitCommandShapeError('the publish push must separate operands with --')
    }
    const operands = argv.slice(separatorIndex + 1)
    if (operands.length !== 2) {
      throw new AuditedGitCommandShapeError(
        'the publish push must carry exactly one remote and one refspec'
      )
    }
    const [, refspec] = operands
    const colon = refspec.indexOf(':')
    if (colon === -1) {
      throw new AuditedGitCommandShapeError('the publish refspec must be <sha>:<ref>')
    }
    const source = refspec.slice(0, colon)
    const destination = refspec.slice(colon + 1)
    if (!FULL_OID.test(source)) {
      throw new AuditedGitCommandShapeError(
        'the publish refspec source must be a full 40-hex OID, never HEAD'
      )
    }
    if (destination !== leaseRef) {
      throw new AuditedGitCommandShapeError(
        'the publish refspec destination must be the leased ref'
      )
    }
  }

  // A publish reads the REAL object store, so any redirection must be absent —
  // the same policy as assertCommitWriteIsolation, and the inverse of
  // assertCandidateIsolation.
  if (env?.GIT_OBJECT_DIRECTORY || env?.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    throw new AuditedGitCommandShapeError(
      'publish commands read the real object store: GIT_OBJECT_DIRECTORY must be unset'
    )
  }
}

export type AuditedGitPublishResult =
  | { ok: true; stdout: string }
  | { ok: false; error: unknown; stderr: string }

/**
 * Runs one publish-protocol command.
 *
 * Returns a result rather than throwing on a non-zero exit: a failed push is NOT
 * proof the remote is unchanged (the server may have accepted the ref before the
 * connection dropped), so the caller must re-probe and classify from evidence.
 *
 * stderr is returned for CLASSIFICATION ONLY. It is never projected and never
 * logged raw — callers map it to a closed code and discard it.
 */
export async function runAuditedGitPublish(
  argv: readonly string[],
  cwd: string,
  options: { timeoutMs?: number } = {}
): Promise<AuditedGitPublishResult> {
  assertAuditedGitArgvShape(argv)
  const env = {
    ...gitOptionalLocksDisabledEnv(),
    // BatchMode, so a push can never hang waiting on an interactive credential
    // or host-key prompt in a context with no terminal.
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
  }
  assertPublishNetworkShape(argv, env)
  try {
    const { stdout } = await gitExecFileAsync([...argv], {
      cwd,
      env,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {})
    })
    return { ok: true, stdout }
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown })?.stderr === 'string'
        ? ((error as { stderr: string }).stderr ?? '')
        : ''
    return { ok: false, error, stderr }
  }
}
