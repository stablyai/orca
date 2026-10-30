import { randomUUID } from 'node:crypto'
import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { isNoWriteFetchHeadUnsupportedError } from '../../shared/git-fetch-head-capability'
import { runWithGitWorktreeOperationLock } from '../../shared/git-worktree-operation-lock'
import {
  REBASE_SOURCE_FETCH_TIMEOUT_MS,
  resolveGitRemoteRebaseSource
} from '../../shared/git-rebase-source'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

export async function gitPullRebaseFromBase(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitWorktreeOperationLock(worktreePath, options.signal, () =>
    gitPullRebaseFromBaseUnlocked(worktreePath, baseRef, options)
  )
}

async function gitPullRebaseFromBaseUnlocked(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions
): Promise<void> {
  await runWithGitReadCacheInvalidation(async () => {
    const operationOptions = {
      ...gitOptionsForWorktree(worktreePath, options),
      terminationBarrier: true,
      captureWslLoginShellOutput: true
    }
    let rebaseRef: string | null = null
    try {
      const source = await resolveGitRemoteRebaseSource(
        (args) => gitExecFileAsync(args, operationOptions),
        baseRef
      )
      let forkPoint: string | null = null
      let hasHead = true
      try {
        const { stdout } = await gitExecFileAsync(
          ['merge-base', '--fork-point', `refs/remotes/${source.displayName}`, 'HEAD'],
          operationOptions
        )
        forkPoint = stdout.trim() || null
      } catch {
        // A first fetch or an unhelpful reflog falls back to Git's merge-base behavior.
        try {
          await gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], operationOptions)
        } catch {
          hasHead = false
        }
      }
      // Why: concurrent fetches can replace FETCH_HEAD and remote-tracking refs between fetch and rebase.
      rebaseRef = `refs/orca/rebase/${randomUUID()}`
      const fetchArgs = [
        source.remoteName,
        `+refs/heads/${source.branchName}:${rebaseRef}`,
        `+refs/heads/${source.branchName}:refs/remotes/${source.displayName}`
      ]
      await withLocalGitCapabilityCacheForExecution(
        { cwd: worktreePath, ...options },
        (capabilities) =>
          capabilities.runWithFallback(
            'fetch-no-write-fetch-head',
            () =>
              gitExecFileAsync(['fetch', '--no-write-fetch-head', ...fetchArgs], {
                ...operationOptions,
                timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS
              }),
            () =>
              gitExecFileAsync(['fetch', ...fetchArgs], {
                ...operationOptions,
                timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS
              }),
            isNoWriteFetchHeadUnsupportedError
          )
      )
      await gitExecFileAsync(
        hasHead
          ? forkPoint
            ? ['rebase', '--onto', rebaseRef, forkPoint]
            : ['rebase', rebaseRef]
          : ['merge', '--ff-only', rebaseRef],
        operationOptions
      )
    } catch (error) {
      throw new Error(normalizeGitErrorMessage(error, 'pull'))
    } finally {
      if (rebaseRef) {
        try {
          const { signal: _abortedSignal, ...cleanupOptions } = gitOptionsForWorktree(
            worktreePath,
            options
          )
          await gitExecFileAsync(['update-ref', '-d', rebaseRef], cleanupOptions)
        } catch {
          // Cleanup must not hide the fetch or rebase result.
        }
      }
    }
  })
}
