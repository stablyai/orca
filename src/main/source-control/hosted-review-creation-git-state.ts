import {
  isRemoteHeadRef,
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { isNoUpstreamError, normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import { gitExecFileAsync } from '../github/gh-utils'
import { isShowRefNoMatchError, probeAnyExactRef } from '../git/exact-ref-probe'
import { gitOptionalLocksDisabledEnv } from '../git/runner'
import { parsePorcelainV1Records, type PorcelainV1Record } from '../git/porcelain-v1-records'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { findExistingWorktreeSymlinkPaths } from '../git/worktree-symlink-detection'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost,
  type ExecutionHostGitRoute
} from '../providers/execution-host-provider-dispatch'
import type { ExecutionHostId } from '../../shared/execution-host'
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

const MAX_REMOTE_REF_OUTPUT_BYTES = 10 * 1024 * 1024

type HostedReviewGitRunOptions = { maxBuffer?: number; timeoutMs?: number }
type HostedReviewGitRun = (
  argv: string[],
  options?: HostedReviewGitRunOptions
) => Promise<{ stdout: string }>

function* iterateGitOutputLines(output: string): Generator<string> {
  let lineStart = 0
  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }
    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }
  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

function parseSuffixRemoteRefs(output: string, base: string, remotes: readonly string[]): string[] {
  const refs = new Set<string>()
  for (const line of iterateGitOutputLines(output)) {
    const separator = line.indexOf(' ')
    if (separator === -1) {
      continue
    }
    const fullRef = line.slice(separator + 1).trim()
    if (!fullRef.startsWith('refs/remotes/') || !isSafeGitRefName(fullRef)) {
      continue
    }
    const shortRef = fullRef.slice('refs/remotes/'.length)
    // A remote-tracking ref has both a remote and branch component. Ignore a
    // malformed bare `refs/remotes/<name>` entry from the suffix stream.
    if (!shortRef.includes('/')) {
      continue
    }
    // The replaced query was `refs/remotes/*/<base>`, where `*` cannot cross a
    // slash. `show-ref -- <base>` matches a suffix at any depth, so require the
    // remote component to be exactly one segment; otherwise a branch named
    // `origin/feature/main` would answer a query for `main`.
    const isSingleRemoteSegmentMatch =
      shortRef.endsWith(`/${base}`) && shortRef.split('/').length === base.split('/').length + 1
    if (
      isRemoteHeadRef(shortRef, remotes) ||
      // A bare `HEAD` denotes the remote's symbolic slot, not every branch
      // whose final component happens to be `HEAD` (for example `feature/HEAD`).
      (base === 'HEAD' && shortRef.endsWith('/HEAD')) ||
      (shortRef !== base && !isSingleRemoteSegmentMatch)
    ) {
      continue
    }
    refs.add(shortRef)
    // Two candidates are enough to establish that a suffix is not unique;
    // retaining more only spends memory without changing the boolean result.
    if (refs.size >= 2) {
      break
    }
  }
  return [...refs]
}

async function listSuffixRemoteBaseRefs(
  run: HostedReviewGitRun,
  base: string,
  remotes: readonly string[]
): Promise<{ refs: string[]; unknown: boolean }> {
  try {
    // The local runner and SSH relay both cap generic Git stdout at 10 MiB.
    const { stdout } = await run(['show-ref', '--', base], {
      maxBuffer: MAX_REMOTE_REF_OUTPUT_BYTES
    })
    return { refs: parseSuffixRemoteRefs(stdout, base, remotes), unknown: false }
  } catch (error) {
    // Unlike --verify, a pattern query exits 1 when it simply has no matches.
    // Other failures (overflow, a broken repository, or dropped SSH) remain
    // inconclusive so callers preserve the submitted candidate (fail-open).
    return isShowRefNoMatchError(error) ? { refs: [], unknown: false } : { refs: [], unknown: true }
  }
}

/**
 * Why not a `connectionId` check: `null` used to mean "local", "runtime host" and "unresolved"
 * alike, so a worktree whose owner is named only by `executionHostId` had its preflight git run
 * against this machine's copy of a remote path. `runtime:` is a routing mistake here rather than a
 * fallback — that environment's server runs its own git.
 */
function requireHostedReviewGitRoute(executionHostId: ExecutionHostId): ExecutionHostGitRoute {
  const route = resolveGitRouteForHost(executionHostId)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route
}

/** Loss of contact is not locality: an SSH host with no provider refuses, it does not run here. */
function requireHostedReviewSshProvider(route: ExecutionHostGitRoute) {
  if (route.kind !== 'ssh' || !route.provider) {
    throw new Error('Remote connection dropped. Click Reconnect on the SSH target before retrying.')
  }
  return route.provider
}

async function runGitForHostedReview(
  repoPath: string,
  args: string[],
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {},
  commandOptions: HostedReviewGitRunOptions = {}
): Promise<{ stdout: string; stderr?: string }> {
  const route = requireHostedReviewGitRoute(executionHostId)
  if (route.kind === 'ssh') {
    const provider = requireHostedReviewSshProvider(route)
    return commandOptions.timeoutMs === undefined
      ? provider.exec(args, repoPath)
      : provider.exec(args, repoPath, { timeoutMs: commandOptions.timeoutMs })
  }
  return gitExecFileAsync(args, {
    cwd: repoPath,
    ...getHostedReviewLocalGitOptions(options),
    ...(commandOptions.maxBuffer === undefined ? {} : { maxBuffer: commandOptions.maxBuffer }),
    ...(commandOptions.timeoutMs === undefined ? {} : { timeout: commandOptions.timeoutMs })
  })
}

export async function getDefaultBaseRef(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) =>
    runGitForHostedReview(repoPath, argv, executionHostId, options)
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
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const base = normalizeHostedReviewBaseRef(candidate).trim()
  if (!base) {
    return false
  }
  const run: HostedReviewGitRun = (argv, commandOptions) =>
    runGitForHostedReview(repoPath, argv, executionHostId, options, commandOptions)

  // Validate the complete tracking ref before interpolating user/repo metadata
  // into Git arguments. In particular, never let `*`, `?`, or control bytes
  // turn this check back into a namespace scan.
  if (!isSafeGitRefName(`refs/remotes/${base}`)) {
    return false
  }

  let configuredRemotes: string[] = []
  try {
    const { stdout: remoteOutput } = await run(['remote'])
    configuredRemotes = remoteOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    // Ref probes can still prove presence or absence without configured names.
  }

  try {
    // Keep the conventional names in the probe set even when a stale tracking
    // ref remains after its remote was removed. This also preserves the old
    // behavior for the common origin/upstream fork workflow without a wildcard.
    const remoteNames = new Set(['origin', 'upstream', ...configuredRemotes])
    const candidateRefs = new Set<string>()
    if (base.includes('/')) {
      // A qualified candidate (e.g. `fork/main`) is itself a complete tracking
      // ref and must remain discoverable even when `fork` is no longer configured.
      candidateRefs.add(`refs/remotes/${base}`)
    }
    for (const remote of remoteNames) {
      const ref = `refs/remotes/${remote}/${base}`
      if (isSafeGitRefName(ref)) {
        candidateRefs.add(ref)
      }
    }
    const exactResult = await probeAnyExactRef(run, [...candidateRefs], {
      maxBuffer: MAX_REMOTE_REF_OUTPUT_BYTES
    })
    if (exactResult.found || exactResult.unknown) {
      return true
    }
    // The previous wildcard query considered every remote-tracking ref,
    // including stale refs left behind after a remote was removed. Keep that
    // behavior after the cheap exact probes; the fallback captures at most
    // 10 MiB, so it cannot recreate the unbounded metadata allocation.
    const suffixResult = await listSuffixRemoteBaseRefs(run, base, configuredRemotes)
    return suffixResult.refs.length > 0 || suffixResult.unknown
  } catch {
    // An unexpected ref-probe failure is inconclusive, so preserve the candidate.
    return true
  }
}

export async function getCurrentBranch(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<string> {
  const { stdout } = await runGitForHostedReview(
    repoPath,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    executionHostId,
    options
  )
  return stripRefPrefix(stdout.trim())
}

export async function hasUncommittedChanges(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const route = requireHostedReviewGitRoute(executionHostId)
  if (route.kind === 'ssh') {
    // Why: the relay restricts generic git.exec, so use the structured status RPC for SSH dirty checks.
    // No shared-link exclusion here: remote worktree creation skips the symlink
    // and shared-directory passes entirely, so a remote worktree never has one.
    return (await requireHostedReviewSshProvider(route).getStatus(repoPath)).entries.length > 0
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
  return await anyRecordIsUserDirt(repoPath, records, options)
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
  options: HostedReviewExecutionOptions
): Promise<boolean> {
  const sharedLinkPaths = options.sharedLinkPaths ?? []
  if (sharedLinkPaths.length === 0 || !records.some((record) => record.xy === '??')) {
    return true
  }
  // Why: only entries that are configured AND really symlinks are excluded, so a
  // regular file the user created at a configured name still blocks creation.
  // Why the distro: git ran in the guest, so an untranslated lstat fails here and this
  // fail-closed check would block review creation over Orca's own symlink.
  const sharedLinks = new Set(
    await findExistingWorktreeSymlinkPaths(worktreePath, sharedLinkPaths, {
      wslDistro: getHostedReviewLocalGitOptions(options).wslDistro
    })
  )
  return records.some((record) => record.xy !== '??' || !sharedLinks.has(record.path))
}

export async function getHostedReviewUpstreamStatus(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<GitUpstreamStatus> {
  const route = requireHostedReviewGitRoute(executionHostId)
  if (route.kind !== 'ssh') {
    return getUpstreamStatus(repoPath, undefined, getHostedReviewLocalGitOptions(options))
  }
  const provider = requireHostedReviewSshProvider(route)
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
