import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import { gitExecFileAsync } from '../github/gh-utils'
import { gitOptionalLocksDisabledEnv } from '../git/runner'
import { parsePorcelainV1Records, type PorcelainV1Record } from '../git/porcelain-v1-records'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { findExistingWorktreeSymlinkPaths } from '../git/worktree-symlink-detection'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

export function stripRefPrefix(ref: string): string {
  return normalizeHostedReviewHeadRef(ref)
}

export function hostedReviewExecutionContext(
  options: HostedReviewExecutionOptions = {}
): HostedReviewExecutionOptions {
  const localGitExecOptions = getHostedReviewLocalGitOptions(options)
  return Object.keys(localGitExecOptions).length > 0 ? { localGitExecOptions } : {}
}

async function runGitForHostedReview(
  repoPath: string,
  args: string[],
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<{ stdout: string; stderr?: string }> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider.exec(args, repoPath)
  }
  return gitExecFileAsync(args, { cwd: repoPath, ...getHostedReviewLocalGitOptions(options) })
}

export async function getDefaultBaseRef(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) =>
    runGitForHostedReview(repoPath, argv, connectionId, options)
  )
}

/**
 * Whether the candidate base resolves to a remote-tracking branch on the
 * executing host.
 *
 * Why: matches under *any* remote (not just origin) and reads the local tracking snapshot, not the live remote.
 */
export async function baseRefExistsOnRemote(
  candidate: string,
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const base = normalizeHostedReviewBaseRef(candidate).trim()
  if (!base) {
    return false
  }
  const run = (argv: string[]): Promise<{ stdout: string }> =>
    runGitForHostedReview(repoPath, argv, connectionId, options)

  const patterns = [`refs/remotes/*/${base}`]
  // `*` does not cross `/`, so a remote-qualified candidate (e.g. `fork/main`) needs its exact tracking ref too.
  if (base.includes('/')) {
    patterns.push(`refs/remotes/${base}`)
  }

  try {
    // for-each-ref exits 0 on no match: empty means absent, a thrown error means transport failure (preserve the candidate).
    const { stdout } = await run(['for-each-ref', '--count=1', '--format=%(refname)', ...patterns])
    return stdout.trim().length > 0
  } catch {
    return true
  }
}

export async function getCurrentBranch(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<string> {
  const { stdout } = await runGitForHostedReview(
    repoPath,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    connectionId,
    options
  )
  return stripRefPrefix(stdout.trim())
}

export async function hasUncommittedChanges(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    // Why: the relay restricts generic git.exec, so use the structured status RPC for SSH dirty checks.
    // No shared-link exclusion here: remote worktree creation skips the symlink
    // and shared-directory passes entirely, so a remote worktree never has one.
    return (await provider.getStatus(repoPath)).entries.length > 0
  }
  // Why: `-z` keeps paths raw so the shared-link comparison below can't be
  // defeated by Git quoting a path with spaces or non-ASCII bytes.
  const { stdout } = await gitExecFileAsync(['status', '--porcelain', '-z'], {
    cwd: repoPath,
    ...getHostedReviewLocalGitOptions(options),
    // Why: don't take Git's optional index lock while the user may be running fetch/pull/rebase in a terminal.
    env: gitOptionalLocksDisabledEnv()
  })
  const records = parsePorcelainV1Records(stdout)
  if (records.length === 0) {
    return false
  }
  return await anyRecordIsUserDirt(repoPath, records, options.sharedLinkPaths ?? [])
}

/** True when any record is real user work rather than a shared symlink Orca put
 *  in the worktree.
 *
 *  Fails closed on purpose: anything not positively identified as an Orca-owned
 *  untracked symlink counts as dirty. A false "clean" would let a review be
 *  created off a branch missing the user's work. */
async function anyRecordIsUserDirt(
  worktreePath: string,
  records: readonly PorcelainV1Record[],
  sharedLinkPaths: readonly string[]
): Promise<boolean> {
  if (sharedLinkPaths.length === 0 || !records.some((record) => record.xy === '??')) {
    return true
  }
  // Why: only entries that are configured AND really symlinks are excluded, so a
  // regular file the user created at a configured name still blocks creation.
  const sharedLinks = new Set(await findExistingWorktreeSymlinkPaths(worktreePath, sharedLinkPaths))
  return records.some((record) => record.xy !== '??' || !sharedLinks.has(record.path))
}

export async function getHostedReviewUpstreamStatus(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GitUpstreamStatus> {
  if (!connectionId) {
    return getUpstreamStatus(repoPath, undefined, getHostedReviewLocalGitOptions(options))
  }
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
  }
  try {
    // Why: the relay blocks generic git.exec, so use its dedicated upstream RPC for SSH divergence.
    return await provider.getUpstreamStatus(repoPath)
  } catch (error) {
    if (isNoUpstreamError(error)) {
      return { hasUpstream: false, ahead: 0, behind: 0 }
    }
    throw new Error(normalizeGitErrorMessage(error, 'upstream'))
  }
}
