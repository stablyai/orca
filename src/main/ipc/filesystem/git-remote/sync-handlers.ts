import { ipcMain } from 'electron'

import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { GitUpstreamStatus } from '../../../../shared/git/status/git-status-types'
import { gitFetch } from '../../../git/remotes/remote'
import { gitSyncForkDefaultBranch } from '../../../git/remotes/fork-sync'
import { getUpstreamStatus } from '../../../git/source-control/upstream/upstream'
import { validateGitPushTarget } from '../../../git/remotes/push-target-validation'
import { resolveRegisteredWorktreePath } from '../../worktrees/removal/registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../worktrees/local-worktree-runtime-options'
import {
  type GitForkSyncExpectedUpstream,
  type GitForkSyncResult,
  validateGitForkSyncExpectedUpstream
} from '../../../../shared/git/remotes/git-fork-sync'
import {
  ipcGitWorktreeTarget,
  materializeWorktreePushTargetRemote
} from '../../worktrees/worktree-remote'
import type { GitSubmoduleRepo } from '../../../../shared/git/status/git-submodule-repo-types'
import { listSubmoduleRepos } from '../../../git/source-control/submodules/submodule-repos'
import { resolveGitActionPath } from './submodule-action-target'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { assertWslUncPathRunning } from '../../../wsl/filesystem/wsl-unc-access-gate'

export function registerGitRemoteSyncHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:upstreamStatus',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<GitUpstreamStatus> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      // Background poll: its Git or UNC read would boot a stopped WSL distro (E9).
      await assertWslUncPathRunning(args.worktreePath)
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await assertWslUncPathRunning(worktreePath, gitOptions.wslDistro)
      return getUpstreamStatus(worktreePath, args.pushTarget, gitOptions)
    }
  )

  ipcMain.handle(
    'git:submoduleRepos',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitSubmoduleRepo[]> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      // Background poll: its Git or UNC read would boot a stopped WSL distro (E9).
      await assertWslUncPathRunning(args.worktreePath)
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await assertWslUncPathRunning(worktreePath, gitOptions.wslDistro)
      return listSubmoduleRepos(worktreePath, gitOptions)
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
        submodulePath?: string
      }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const registeredPath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        registeredPath
      )
      const worktreePath = await resolveGitActionPath(args, registeredPath, gitOptions)
      const materializedPushTarget = args.pushTarget
        ? await materializeWorktreePushTargetRemote(
            worktreePath,
            args.pushTarget,
            store,
            undefined,
            gitOptions,
            ipcGitWorktreeTarget(args)
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
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
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
