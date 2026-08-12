import {
  branchHasNoUnmergedChangesOnAnyTarget,
  getBranchCleanupTargetRefs
} from '../../shared/git-branch-cleanup'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'

export type WorktreeBranchMergeStateOptions = {
  wslDistro?: string
  signal?: AbortSignal
  timeout?: number
}

/**
 * A `git` runner in the repo's own checkout, shaped for the shared branch-cleanup
 * helpers. The `stdin` hook is what lets those helpers pipe a diff into
 * `patch-id`, which is how a squash merge is proven.
 */
function createBranchCleanupExec(repoPath: string, options: WorktreeBranchMergeStateOptions) {
  return (argv: string[], execOptions?: { stdin?: string }) =>
    gitExecFileAsync(argv, {
      cwd: repoPath,
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
      ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {})
    })
}

/**
 * Whether the branch's changes are already contained in one of the repo's
 * cleanup targets (`branch.<name>.base`, `origin/HEAD`, or the primary
 * checkout's HEAD). Resolves to null when Git could not prove it either way.
 *
 * Unlike the post-delete branch cleanup this never fetches: a background sweep
 * must not reach the network, so a branch whose base ref is stale locally is
 * reported unmerged until the next refresh.
 */
export async function isWorktreeBranchMergedIntoBase(
  repoPath: string,
  branchName: string,
  options: WorktreeBranchMergeStateOptions = {}
): Promise<boolean | null> {
  if (!branchName) {
    return null
  }
  const runGit = createBranchCleanupExec(repoPath, options)
  try {
    const targetRefs = await getBranchCleanupTargetRefs(runGit, branchName)
    return await withLocalGitCapabilityCacheForExecution(
      {
        cwd: repoPath,
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      },
      (capabilities) =>
        branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, targetRefs, capabilities)
    )
  } catch (error) {
    console.warn(`[git] Failed to read merge state for branch "${branchName}"`, error)
    return null
  }
}

/**
 * Whether the branch has an upstream configured. Read from config rather than
 * the remote-tracking ref because merging a PR usually deletes the remote
 * branch, and that must not read as "never published".
 */
export async function hasWorktreeBranchUpstreamConfigured(
  repoPath: string,
  branchName: string,
  options: WorktreeBranchMergeStateOptions = {}
): Promise<boolean | null> {
  if (!branchName) {
    return null
  }
  const runGit = createBranchCleanupExec(repoPath, options)
  try {
    // `--default` (Git 2.18) keeps a missing key an exit-0 answer instead of an error.
    const { stdout } = await runGit([
      'config',
      '--get',
      '--default',
      '',
      `branch.${branchName}.remote`
    ])
    return stdout.trim().length > 0
  } catch (error) {
    console.warn(`[git] Failed to read upstream config for branch "${branchName}"`, error)
    return null
  }
}
