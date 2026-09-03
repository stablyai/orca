import { gitExecFileAsync } from '../git/runner'
import { withLocalGitCapabilityCacheForExecution } from '../git/git-capability-state'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  getBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../shared/execution-host'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type WorkspaceCleanupMergeProbeOptions = LocalProjectWorktreeGitOptions & {
  signal?: AbortSignal
}

/**
 * Reports whether Git can prove the workspace branch contributes no unmerged
 * changes to its base — the same predicate the delete path uses before it drops
 * a local branch, so a "merged" recommendation and the branch cleanup that
 * follows it can never disagree.
 *
 * Returns null when the verdict is unknowable (SSH, detached HEAD, probe
 * failure). Callers must read null as "not proven merged".
 */
export async function readWorkspaceCleanupMergeVerdict(
  worktree: Worktree,
  repo: Repo,
  options: WorkspaceCleanupMergeProbeOptions = {}
): Promise<boolean | null> {
  // Why: this runs git locally at repo.path, so it may only judge a workspace
  // this machine owns. SSH cannot run the proof at all (the relay's git.exec
  // allowlist exposes no merge-tree, cherry, or patch-id), and a runtime-owned
  // workspace would be judged against whatever happens to sit at that local
  // path — a wrong "merged" there would drop a real unpushed-commits blocker.
  if (
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
    getWorktreeExecutionHostId(worktree, repo) !== LOCAL_EXECUTION_HOST_ID
  ) {
    return null
  }
  const branchName = readWorkspaceCleanupBranchName(worktree)
  if (!branchName) {
    return null
  }

  // Why: the probe compares the branch against the *repo's* HEAD and saved base.
  // Running it inside the worktree would make HEAD the branch itself, which
  // proves every branch "merged" into itself and would delete live work.
  const cwd = repo.path
  const runGit = (args: string[], execOptions?: { stdin?: string }): Promise<{ stdout: string }> =>
    gitExecFileAsync(args, {
      cwd,
      ...(options.wslDistro !== undefined ? { wslDistro: options.wslDistro } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {})
    })

  try {
    const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
    if (targetRefs.length === 0) {
      return null
    }
    return await withLocalGitCapabilityCacheForExecution(
      {
        cwd,
        ...(options.wslDistro !== undefined ? { wslDistro: options.wslDistro } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      },
      // Why: no lazy fetch here. A scan probes every workspace in the project, so
      // the refreshing variant would hit the network once per branch. Judging
      // against local refs can only under-report a merge, never invent one, and
      // an unreported merge just leaves the workspace unrecommended.
      (capabilities) =>
        branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, targetRefs, capabilities)
    )
  } catch {
    return null
  }
}

function readWorkspaceCleanupBranchName(worktree: Worktree): string | null {
  const branchName = worktree.branch.replace(/^refs\/heads\//, '').trim()
  // Why: a detached HEAD has no branch to compare, and a leading dash would be
  // read as a Git option.
  if (!branchName || branchName === 'HEAD' || branchName.startsWith('-')) {
    return null
  }
  return branchName
}
