import { randomUUID } from 'node:crypto'
import type { RequestContext } from './dispatcher'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { resolveRelayPushTarget } from './git-handler-push-target'
import { normalizeGitErrorMessage, runPullWithDivergenceFallback } from '../shared/git-remote-error'
import { assertGitPushTargetShape } from '../shared/git-push-target-validation'
import type { GitCommandRunner } from '../shared/git-publish-target-status'
import type { GitPushTarget } from '../shared/worktree/types'
import { resolveEffectiveGitUpstream } from '../shared/git-effective-upstream'
import { runWithGitWorktreeOperationLock } from '../shared/git-worktree-operation-lock'
import {
  REBASE_FROM_BASE_OPERATION_TIMEOUT_MS,
  REBASE_SOURCE_FETCH_TIMEOUT_MS,
  resolveGitRemoteRebaseSource
} from '../shared/git-rebase-source'
import { isNoWriteFetchHeadUnsupportedError } from '../shared/git-fetch-head-capability'

export class GitHandlerSyncOperations extends GitHandlerOperationContext {
  async push(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    // Why: mirror src/main/git/remote.ts — push to a configured upstream when present so SSH worktrees with non-origin targets aren't repointed.
    void params.publish
    try {
      try {
        const target = await resolveRelayPushTarget(
          this.git.bind(this),
          worktreePath,
          params.pushTarget
        )
        const args = [
          'push',
          ...(params.forceWithLease === true ? ['--force-with-lease'] : []),
          '--set-upstream',
          ...(target ? [target.remote, target.refspec] : ['origin', 'HEAD'])
        ]
        await this.git(args, worktreePath)
      } catch (error) {
        // Why: mirror local gitPush normalization so SSH users get "non-fast-forward / pull first" guidance instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'push'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async pullWithArgs(
    params: Record<string, unknown>,
    pullArgs: string[],
    signal?: AbortSignal
  ) {
    const worktreePath = params.worktreePath as string
    return runWithGitWorktreeOperationLock(worktreePath, signal, () =>
      this.runPullWithArgsUnlocked(params, pullArgs)
    )
  }

  private async runPullWithArgsUnlocked(
    params: Record<string, unknown>,
    pullArgs: string[]
  ): Promise<void> {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const runPull = async (effectiveArgs: string[]): Promise<void> => {
      if (params.pushTarget !== undefined) {
        assertGitPushTargetShape(params.pushTarget)
        const pushTarget = params.pushTarget as GitPushTarget
        await this.git(['check-ref-format', '--branch', pushTarget.branchName], worktreePath)
        await this.git(
          ['pull', ...effectiveArgs, pushTarget.remoteName, pushTarget.branchName],
          worktreePath
        )
        return
      }
      const upstream = await resolveEffectiveGitUpstream((args) => this.git(args, worktreePath))
      if (upstream && !upstream.isConfiguredUpstream) {
        // Why: legacy Orca branches may track origin/main while pushes target origin/<branch>; pull the same effective branch the UI reports.
        await this.git(
          ['pull', ...effectiveArgs, upstream.remoteName, upstream.branchName],
          worktreePath
        )
        return
      }
      await this.git(['pull', ...effectiveArgs], worktreePath)
    }

    try {
      try {
        await runPullWithDivergenceFallback(pullArgs, runPull)
      } catch (error) {
        // Why: mirror local gitPull normalization so SSH users get actionable messages instead of raw git stderr.
        throw new Error(normalizeGitErrorMessage(error, 'pull'))
      }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async pull(params: Record<string, unknown>, context?: RequestContext) {
    // Why: plain `git pull` honors user merge/rebase/ff policy.
    await this.pullWithArgs(params, [], context?.signal)
  }

  async fastForward(params: Record<string, unknown>, context?: RequestContext) {
    await this.pullWithArgs(params, ['--ff-only'], context?.signal)
  }

  async rebaseFromBase(params: Record<string, unknown>, context?: RequestContext) {
    return runWithGitWorktreeOperationLock(params.worktreePath as string, context?.signal, () =>
      this.runRebaseFromBase(params, context)
    )
  }

  private async runRebaseFromBase(params: Record<string, unknown>, context?: RequestContext) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const baseRef = params.baseRef as string
    let rebaseRef: string | null = null
    const controller = new AbortController()
    const abortFromContext = () => controller.abort()
    if (context?.signal?.aborted) {
      controller.abort()
    } else {
      context?.signal?.addEventListener('abort', abortFromContext, { once: true })
    }
    const timeout = setTimeout(() => controller.abort(), REBASE_FROM_BASE_OPERATION_TIMEOUT_MS)
    try {
      try {
        const source = await resolveGitRemoteRebaseSource(
          ((args) =>
            this.git(args, worktreePath, {
              signal: controller.signal,
              terminationBarrier: true
            })) as GitCommandRunner,
          baseRef
        )
        let forkPoint: string | null = null
        let hasHead = true
        try {
          const { stdout } = await this.git(
            ['merge-base', '--fork-point', `refs/remotes/${source.displayName}`, 'HEAD'],
            worktreePath,
            { signal: controller.signal, terminationBarrier: true }
          )
          forkPoint = stdout.trim() || null
        } catch {
          // A first fetch or an unhelpful reflog falls back to Git's merge-base behavior.
          try {
            await this.git(['rev-parse', '--verify', 'HEAD'], worktreePath, {
              signal: controller.signal,
              terminationBarrier: true
            })
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
        await this.gitCapabilities.runWithFallback(
          'fetch-no-write-fetch-head',
          () =>
            this.git(['fetch', '--no-write-fetch-head', ...fetchArgs], worktreePath, {
              timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS,
              signal: controller.signal,
              terminationBarrier: true
            }),
          () =>
            this.git(['fetch', ...fetchArgs], worktreePath, {
              timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS,
              signal: controller.signal,
              terminationBarrier: true
            }),
          isNoWriteFetchHeadUnsupportedError
        )
        await this.git(
          hasHead
            ? forkPoint
              ? ['rebase', '--onto', rebaseRef, forkPoint]
              : ['rebase', rebaseRef]
            : ['merge', '--ff-only', rebaseRef],
          worktreePath,
          { signal: controller.signal, terminationBarrier: true }
        )
      } catch (error) {
        throw new Error(normalizeGitErrorMessage(error, 'pull'))
      }
    } finally {
      if (rebaseRef) {
        try {
          await this.git(['update-ref', '-d', rebaseRef], worktreePath)
        } catch {
          // Cleanup must not hide the fetch or rebase result.
        }
      }
      clearTimeout(timeout)
      context?.signal?.removeEventListener('abort', abortFromContext)
      this.clearGitMutationReadCaches()
    }
  }
}
