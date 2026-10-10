import { ipcMain } from 'electron'
import type {
  GitForkSyncExpectedUpstream,
  GitForkSyncResult
} from '../../../../shared/git-fork-sync'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'
import { gitFetch } from '../../../git/remote'
import { gitSyncForkDefaultBranch } from '../../../git/fork-sync'
import { getUpstreamStatus } from '../../../git/upstream'
import { validateGitPushTarget } from '../../../git/push-target-validation'
import { resolveRegisteredWorktreePath } from '../../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../local-worktree-runtime-options'
import { assertValidGitPushTarget } from '../../../../shared/git-push-target-validation'
import { validateGitForkSyncExpectedUpstream } from '../../../../shared/git-fork-sync'
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from '../../worktree-remote'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export function registerGitRemoteSyncHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:upstreamStatus',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<GitUpstreamStatus> => {
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        if (args.pushTarget) {
          assertValidGitPushTarget(args.pushTarget)
        }
        return route.provider.getUpstreamStatus(args.worktreePath, args.pushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getUpstreamStatus(worktreePath, args.pushTarget, gitOptions)
    }
  )

  ipcMain.handle(
    'git:fetch',
    async (
      _event,
      args: {
        worktreePath: string
        worktreeId?: string
        connectionId?: string
        pushTarget?: GitPushTarget
      }
    ): Promise<void> => {
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        if (args.pushTarget) {
          assertValidGitPushTarget(args.pushTarget)
        }
        const materializedPushTarget = args.pushTarget
          ? await materializeWorktreePushTargetRemoteSsh(
              route.provider,
              args.worktreePath,
              args.pushTarget,
              store,
              undefined,
              args.worktreeId
            )
          : undefined
        return route.provider.fetchRemote(args.worktreePath, materializedPushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      const materializedPushTarget = args.pushTarget
        ? await materializeWorktreePushTargetRemote(
            worktreePath,
            args.pushTarget,
            store,
            undefined,
            gitOptions,
            args.worktreeId
          )
        : undefined
      if (materializedPushTarget) {
        await validateGitPushTarget(worktreePath, materializedPushTarget, {
          ...gitOptions,
          admissionTier: 'interactive'
        })
      }
      await gitFetch(worktreePath, materializedPushTarget, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:syncFork',
    async (
      _event,
      args: {
        worktreePath: string
        connectionId?: string
        expectedUpstream: GitForkSyncExpectedUpstream
      }
    ): Promise<GitForkSyncResult> => {
      const expectedUpstream = validateGitForkSyncExpectedUpstream(args.expectedUpstream, {
        required: true
      })
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        return route.provider.syncForkDefaultBranch(args.worktreePath, expectedUpstream)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return gitSyncForkDefaultBranch(worktreePath, expectedUpstream, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
