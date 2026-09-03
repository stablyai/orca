import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

type LocalBaseRefRefreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      localOid: string
      remoteOid: string
      behind: number
      ownerWorktreePath?: string
    }
  | {
      refreshable: false
      result: LocalBaseRefRefreshResult
    }

function parseRemoteTrackingLocalBaseRef(
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): { baseRef: string; localBranch: string; fullRef: string } | undefined {
  if (remoteTrackingBase?.ref === remoteTrackingRef) {
    return {
      baseRef: remoteTrackingBase.base,
      localBranch: remoteTrackingBase.branch,
      fullRef: `refs/heads/${remoteTrackingBase.branch}`
    }
  }

  const remoteRefPrefix = 'refs/remotes/'
  if (!remoteTrackingRef.startsWith(remoteRefPrefix)) {
    return undefined
  }

  // Why: only proven remote-tracking refs get refresh status; slash-containing local branches (release/2026) must not fake a "not refreshed" warning.
  const shortRemoteRef = remoteTrackingRef.slice(remoteRefPrefix.length)
  const slashIndex = shortRemoteRef.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }

  const localBranch = shortRemoteRef.slice(slashIndex + 1)
  return {
    baseRef: baseBranch,
    localBranch,
    fullRef: `refs/heads/${localBranch}`
  }
}

function parseRevListDrift(output: string): { ahead: number; behind: number } | null {
  const counts = parseGitRevListAheadBehindCounts(output)
  return counts.status === 'ok' ? { ahead: counts.ahead, behind: counts.behind } : null
}

export async function evaluateLocalBaseRefRefreshability(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {},
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<LocalBaseRefRefreshability | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }

  const resultBase = { baseRef: parsed.baseRef, localBranch: parsed.localBranch }

  let drift: { ahead: number; behind: number }
  let localOid = ''
  let remoteOid = ''
  try {
    // Why: advisory and mutating paths must agree on "safe to fast-forward"; `rev-list A...B` proves no local-only commits and how far behind.
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${parsed.fullRef}...${remoteTrackingRef}`],
      gitExecOptions(repoPath, options)
    )
    const parsedDrift = parseRevListDrift(stdout)
    if (!parsedDrift || parsedDrift.ahead !== 0) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    if (!shouldInspectOwner(parsedDrift.behind)) {
      // Why: a current local ref yields no update suggestion, so the advisory path skips OID resolution and owner inspection.
      return undefined
    }
    const { stdout: localOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${parsed.fullRef}^{commit}`],
      gitExecOptions(repoPath, options)
    )
    localOid = localOidOutput.trim()
    if (!localOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    const { stdout: remoteOidOutput } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${remoteTrackingRef}^{commit}`],
      gitExecOptions(repoPath, options)
    )
    remoteOid = remoteOidOutput.trim()
    if (!remoteOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    await gitExecFileAsync(
      ['merge-base', '--is-ancestor', localOid, remoteOid],
      gitExecOptions(repoPath, options)
    )
    drift = parsedDrift
  } catch {
    // Why (#15331): the probes above also fail when refs/heads/<branch> is simply absent; a branch that
    // does not exist yet cannot be stale, so report nothing instead of a bogus divergence warning.
    // Only a proven absence suppresses: an unusable repo leaves the warning alone.
    const presence = await probeWorktreeBaseRefPresence(
      (args) => gitExecFileAsync(args, gitExecOptions(repoPath, options)),
      parsed.fullRef
    )
    if (presence === 'absent') {
      return undefined
    }
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    // Why: if the local base branch is checked out, only update it when that owner worktree is clean.
    const { stdout: worktreeListOutput } = await gitExecFileAsync(
      ['worktree', 'list', '--porcelain'],
      gitExecOptions(repoPath, options)
    )
    const worktrees = parseWorktreeList(
      translateWslOutputPaths(worktreeListOutput, repoPath, options)
    )
    const ownerWorktree = worktrees.find((wt) => wt.branch === parsed.fullRef)

    if (ownerWorktree) {
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(ownerWorktree.path, options)
      )
      if (status.trim()) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: ownerWorktree.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef: parsed.fullRef,
        remoteTrackingRef,
        localOid,
        remoteOid,
        behind: drift.behind,
        ownerWorktreePath: ownerWorktree.path
      }
    }

    // Why: localBranch isn't checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath signals the mutating path to take it.
    return {
      refreshable: true,
      ...resultBase,
      fullRef: parsed.fullRef,
      remoteTrackingRef,
      localOid,
      remoteOid,
      behind: drift.behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

export async function getLocalBaseRefUpdateSuggestionForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options,
    (behind) => behind > 0
  )
  if (!evaluation?.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}
