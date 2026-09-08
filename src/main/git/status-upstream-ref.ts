import { readGitRemoteTrackingRef } from '../../shared/git-remote-tracking-ref'
import type { GitUpstreamStatusIdentity } from '../../shared/git-upstream-identity'
import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'
import { gitBranchNameFromFullRef } from '../../shared/git-upstream-identity'
import { resolveEffectiveGitUpstreamForBranch } from '../../shared/git-effective-upstream'

type GitStatusUpstreamRefExec = (
  args: string[],
  cwd: string,
  signal: AbortSignal
) => Promise<{ stdout: string }>

export async function resolveGitStatusUpstreamRefBinding(
  execGit: GitStatusUpstreamRefExec,
  worktreePath: string,
  branch: string,
  upstreamName: string,
  signal: AbortSignal,
  trackingRef?: string,
  identity?: GitUpstreamStatusIdentity
): Promise<GitStatusUpstreamRefResolution | undefined> {
  const branchName = gitBranchNameFromFullRef(branch)
  if (!branchName || !isSafeGitRefName(branch)) {
    return undefined
  }
  const runGit = (args: string[]): Promise<{ stdout: string }> =>
    execGit(args, worktreePath, signal)
  if (identity) {
    if (identity.selector.kind !== 'named-remote') {
      return undefined
    }
    const mergeBranch = gitBranchNameFromFullRef(identity.mergeRef)
    if (!mergeBranch) {
      return undefined
    }
    const resolved = await readGitRemoteTrackingRef(runGit, identity.selector.value, mergeBranch)
    return resolved && resolved === trackingRef && resolved === identity.trackingRef
      ? { trackingRef: resolved, remoteName: identity.selector.value }
      : undefined
  }
  // Old publishers are reconciled against execution-host intent, never namespace guesses.
  const effective = await resolveEffectiveGitUpstreamForBranch(runGit, branchName)
  if (
    !effective?.remoteName ||
    !effective.upstreamRef ||
    (!effective.isConfiguredUpstream && effective.operationSelector?.kind === 'literal-url')
  ) {
    return undefined
  }
  return (trackingRef
    ? effective.upstreamRef === trackingRef
    : effective.upstreamName === upstreamName) && isSafeGitRefName(effective.upstreamRef)
    ? { trackingRef: effective.upstreamRef, remoteName: effective.remoteName }
    : undefined
}

export type GitStatusUpstreamRefResolution = { trackingRef: string; remoteName: string }

export async function resolveGitStatusUpstreamRef(
  ...args: Parameters<typeof resolveGitStatusUpstreamRefBinding>
): Promise<string | undefined> {
  return (await resolveGitStatusUpstreamRefBinding(...args))?.trackingRef
}
