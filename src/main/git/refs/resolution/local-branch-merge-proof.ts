import {
  branchHasNoUnmergedChangesOnAnyTarget,
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  getBranchCleanupTargetRefs,
  type GitBranchCleanupExecOptions
} from '../../../../shared/git/branches/git-branch-cleanup'
import { withLocalGitCapabilityCacheForExecution } from '../../command-runner/host-routing/git-capability-state'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { createLocalGitObjectQuarantine } from '../../objects/local-git-object-quarantine'
import {
  gitExecOptions,
  type GitWorktreeExecOptions
} from '../../worktrees/worktree-operation-options'

/** Git's proof that a local branch adds no changes to a target, squash and rebase merges included. */
export async function localBranchHasNoUnmergedChanges(args: {
  cwd: string
  branchName: string
  /** Defaults to the branch-cleanup targets, which include `cwd`'s HEAD: pass explicit refs from a linked worktree. */
  targetRefs?: string[]
  /** Fetch stale remote targets before giving up; scans stay offline. */
  refreshRemoteTargets: boolean
  options?: GitWorktreeExecOptions
}): Promise<boolean> {
  const { cwd, branchName, refreshRemoteTargets, options = {} } = args
  const quarantine = createLocalGitObjectQuarantine(cwd, options)
  const runGit = (argv: string[], execOptions?: GitBranchCleanupExecOptions) => {
    const run = (env: NodeJS.ProcessEnv | undefined) =>
      gitExecFileAsync(argv, {
        ...gitExecOptions(cwd, options),
        ...(execOptions?.stdin !== undefined ? { stdin: execOptions.stdin } : {}),
        ...(env ? { env } : {})
      })
    return execOptions?.discardWrittenObjects ? quarantine.run(run) : run(undefined)
  }
  const targetRefs = args.targetRefs ?? (await getBranchCleanupTargetRefs(runGit, branchName))
  return withLocalGitCapabilityCacheForExecution(
    { cwd, wslDistro: options.wslDistro, signal: options.signal },
    (capabilities) =>
      refreshRemoteTargets
        ? branchHasNoUnmergedChangesWithLazyTargetRefresh(
            runGit,
            branchName,
            targetRefs,
            capabilities
          )
        : branchHasNoUnmergedChangesOnAnyTarget(runGit, branchName, targetRefs, capabilities)
  )
}
