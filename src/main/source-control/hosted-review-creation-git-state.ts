import {
  isRemoteHeadRef,
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import { gitExecFileAsync } from '../github/gh-utils'
import { isShowRefNoMatchError, probeAnyExactRef } from '../git/exact-ref-probe'
import { gitOptionalLocksDisabledEnv } from '../git/runner'
import { parsePorcelainV1Records, type PorcelainV1Record } from '../git/porcelain-v1-records'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { getUpstreamStatus } from '../git/upstream'
import { findExistingWorktreeSymlinkPaths } from '../git/worktree-symlink-detection'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
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
    if (!shortRef.includes('/')) {
      continue
    }
    // show-ref suffixes cross slashes; require exactly one remote segment so origin/feature/main cannot prove main exists.
    const isSingleRemoteSegmentMatch =
      shortRef.endsWith(`/${base}`) && shortRef.split('/').length === base.split('/').length + 1
    if (
      isRemoteHeadRef(shortRef, remotes) ||
      // Bare HEAD names the remote symbolic slot, never feature/HEAD.
      (base === 'HEAD' && shortRef.endsWith('/HEAD')) ||
      (shortRef !== base && !isSingleRemoteSegmentMatch)
    ) {
      continue
    }
    refs.add(shortRef)
    // Two refs establish ambiguity; retaining more wastes memory.
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
    const { stdout } = await run(['show-ref', '--', base], {
      maxBuffer: MAX_REMOTE_REF_OUTPUT_BYTES
    })
    return { refs: parseSuffixRemoteRefs(stdout, base, remotes), unknown: false }
  } catch (error) {
    // Pattern queries exit 1 on no match; overflow/repository/transport failures remain inconclusive and preserve the candidate.
    return isShowRefNoMatchError(error) ? { refs: [], unknown: false } : { refs: [], unknown: true }
  }
}

/** Require an explicit local route: nullable connectionId conflates local, unresolved and remote-host ownership. */
async function runGitForHostedReview(
  repoPath: string,
  args: string[],
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {},
  commandOptions: HostedReviewGitRunOptions = {}
): Promise<{ stdout: string; stderr?: string }> {
  requireReachableGitRoute(executionHostId)
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

/** Read remote-tracking refs on the executing host, under any remote; never query the live remote. */
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

  // Validate full ref syntax so wildcards/control bytes cannot turn metadata into a namespace scan.
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
  } catch {}

  try {
    // Probe conventional names too for stale origin/upstream refs after remote removal.
    const remoteNames = new Set(['origin', 'upstream', ...configuredRemotes])
    const candidateRefs = new Set<string>()
    if (base.includes('/')) {
      // Qualified refs remain discoverable even after their remote was unconfigured.
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
    // Preserve stale-remote suffix matching with a 10MiB bound after cheap exact probes.
    const suffixResult = await listSuffixRemoteBaseRefs(run, base, configuredRemotes)
    return suffixResult.refs.length > 0 || suffixResult.unknown
  } catch {
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
  requireReachableGitRoute(executionHostId)
  // NUL-delimited raw paths keep Git quoting from defeating shared-link matching.
  const { stdout } = await gitExecFileAsync(['status', '--porcelain', '-z'], {
    cwd: repoPath,
    ...getHostedReviewLocalGitOptions(options),
    // Avoid optional index locks while users run Git commands.
    env: gitOptionalLocksDisabledEnv()
  })
  const records = parsePorcelainV1Records(stdout)
  if (records.length === 0) {
    return false
  }
  return await anyRecordIsUserDirt(repoPath, records, options)
}

/** Only positively identified Orca-owned untracked symlinks are clean; uncertainty must preserve the user-work blocker. */
async function anyRecordIsUserDirt(
  worktreePath: string,
  records: readonly PorcelainV1Record[],
  options: HostedReviewExecutionOptions
): Promise<boolean> {
  const sharedLinkPaths = options.sharedLinkPaths ?? []
  if (sharedLinkPaths.length === 0 || !records.some((record) => record.xy === '??')) {
    return true
  }
  // Exclude configured real symlinks only; translate guest paths before lstat or Orca-owned WSL links look like user dirt.
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
  requireReachableGitRoute(executionHostId)
  return getUpstreamStatus(repoPath, undefined, getHostedReviewLocalGitOptions(options))
}
