import { ipcMain } from 'electron'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { gitFastForward, gitPull, gitPullRebaseFromBase, gitPush } from '../../../git/remote'
import { validateGitPushTarget } from '../../../git/push-target-validation'
import { resolveRegisteredWorktreePath } from '../../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../local-worktree-runtime-options'
import { assertValidGitPushTarget } from '../../../../shared/git-push-target-validation'
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from '../../worktree-remote'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export function registerGitRemoteBranchMutationHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:push',
    async (
      _event,
      args: {
        worktreePath: string
        worktreeId?: string
        publish?: boolean
        forceWithLease?: boolean
        connectionId?: string
        pushTarget?: GitPushTarget
      }
    ): Promise<void> => {
      // Why: coerce to strict boolean so a malformed payload (e.g. string 'false') can't enable --set-upstream; mirror in src/relay/git-handler.ts.
      const publish = args.publish === true
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        if (args.pushTarget) {
          assertValidGitPushTarget(args.pushTarget)
        }
        // Why: a fork remote deferred at create time (#17828) must exist before push.
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
        return route.provider.pushBranch(args.worktreePath, publish, materializedPushTarget, {
          forceWithLease: args.forceWithLease === true
        })
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
      await gitPush(worktreePath, publish, materializedPushTarget, {
        forceWithLease: args.forceWithLease === true,
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:pull',
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
        return route.provider.pullBranch(args.worktreePath, materializedPushTarget)
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
      await gitPull(worktreePath, materializedPushTarget, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:fastForward',
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
        return route.provider.fastForwardBranch(args.worktreePath, materializedPushTarget)
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
      await gitFastForward(worktreePath, materializedPushTarget, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:rebaseFromBase',
    async (
      _event,
      args: { worktreePath: string; baseRef: string; connectionId?: string }
    ): Promise<void> => {
      const route = requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      if (route.kind === 'ssh') {
        return route.provider.rebaseFromBase(args.worktreePath, args.baseRef)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await gitPullRebaseFromBase(worktreePath, args.baseRef, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
