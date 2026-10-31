import {
  normalizeGitErrorMessage,
  runPullWithDivergenceFallback
} from '../../shared/git-remote-error'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import {
  postponeRepoRefMaintenance,
  withRepoRefMaintenancePaused
} from './local-repo-ref-maintenance'
import { validateGitPushTarget } from './push-target-validation'
import { gitExecFileAsync } from './runner'
import { fetchForkBranch, runForkNativeAction, withForkRemoteLock } from './fork-remote-refspec'
import { runWithGitReadCacheInvalidation } from './status'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'

export { gitPullRebaseFromBase } from './remote-rebase'

function explicitPushTarget(target: GitPushTarget): { remote: string; refspec: string } {
  return { remote: target.remoteName, refspec: `HEAD:${target.branchName}` }
}

export async function gitPush(
  worktreePath: string,
  _publish = false,
  pushTarget?: GitPushTarget,
  options: { forceWithLease?: boolean } & GitRuntimeOptions = {}
): Promise<void> {
  try {
    if (pushTarget) {
      await validateGitPushTarget(worktreePath, pushTarget, options)
    }
    const runtime = gitOptionsForWorktree(worktreePath, options)
    const executePush = async () => {
      // Honor configured fork push targets; use origin/HEAD only for first publication.
      const target = pushTarget
        ? explicitPushTarget(pushTarget)
        : await resolveConfiguredGitPushTarget(
            (args) => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
            {
              cwd: worktreePath,
              scope: options.wslDistro,
              exec: (args, cwd) => gitExecFileAsync(args, { ...runtime, cwd })
            }
          )
      const args = [
        'push',
        ...(options.forceWithLease ? ['--force-with-lease'] : []),
        '--set-upstream',
        ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
      ]
      const push = () => gitExecFileAsync(args, runtime)
      await (pushTarget?.remoteUrl
        ? runForkNativeAction(
            (argv, cwd) => gitExecFileAsync(argv, { ...runtime, cwd }),
            worktreePath,
            pushTarget,
            'push',
            push,
            options.wslDistro
          )
        : push())
    }
    await (pushTarget
      ? executePush()
      : withForkRemoteLock(
          (args, cwd) => gitExecFileAsync(args, { ...runtime, cwd }),
          worktreePath,
          executePush,
          options.wslDistro
        ))
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

async function gitPullWithArgs(
  worktreePath: string,
  pullArgs: string[],
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  const runPull = async (effectiveArgs: string[]): Promise<void> => {
    if (pushTarget) {
      const target = await validateGitPushTarget(worktreePath, pushTarget, options)
      const runtime = gitOptionsForWorktree(worktreePath, options)
      const pull = () =>
        gitExecFileAsync(['pull', ...effectiveArgs, target.remoteName, target.branchName], runtime)
      await (target.remoteUrl
        ? runForkNativeAction(
            (args, cwd) => gitExecFileAsync(args, { ...runtime, cwd }),
            worktreePath,
            target,
            'pull',
            pull,
            options.wslDistro
          )
        : pull())
      return
    }
    const upstream = await resolveEffectiveGitUpstream((args) =>
      gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    )
    if (upstream && !upstream.isConfiguredUpstream) {
      // Legacy worktrees may track origin/main; pull the effective branch shown by the UI.
      await gitExecFileAsync(
        ['pull', ...effectiveArgs, upstream.remoteName, upstream.branchName],
        gitOptionsForWorktree(worktreePath, options)
      )
      return
    }

    await gitExecFileAsync(['pull', ...effectiveArgs], gitOptionsForWorktree(worktreePath, options))
  }

  try {
    await runPullWithDivergenceFallback(pullArgs, runPull)
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitPull(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  // Respect the configured pull strategy and surface conflicts through the existing resolution flow.
  postponeRepoRefMaintenance()
  await withRepoRefMaintenancePaused('git-pull', () =>
    runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
      runWithGitReadCacheInvalidation(() => gitPullWithArgs(worktreePath, [], pushTarget, options))
    )
  )
}

export async function gitFastForward(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  postponeRepoRefMaintenance()
  await withRepoRefMaintenancePaused('git-fast-forward', () =>
    runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
      runWithGitReadCacheInvalidation(() =>
        gitPullWithArgs(worktreePath, ['--ff-only'], pushTarget, options)
      )
    )
  )
}

export async function gitFetch(
  worktreePath: string,
  pushTarget?: GitPushTarget,
  options: GitRuntimeOptions = {}
): Promise<void> {
  // Pruning needs packed-refs.lock; wait for an idle pack's rewrite window rather than failing Fetch.
  postponeRepoRefMaintenance()
  try {
    await withRepoRefMaintenancePaused('git-fetch', async () => {
      if (pushTarget) {
        const target = await validateGitPushTarget(worktreePath, pushTarget, options)
        const runtimeOptions = gitOptionsForWorktree(worktreePath, options)
        await (target.remoteUrl
          ? fetchForkBranch(
              (args, cwd) => gitExecFileAsync(args, { ...runtimeOptions, cwd }),
              worktreePath,
              target.remoteName,
              target.branchName,
              options.wslDistro,
              target.remoteUrl
            )
          : gitExecFileAsync(['fetch', '--prune', target.remoteName], runtimeOptions))
        return
      }
      await gitExecFileAsync(['fetch', '--prune'], gitOptionsForWorktree(worktreePath, options))
    })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
