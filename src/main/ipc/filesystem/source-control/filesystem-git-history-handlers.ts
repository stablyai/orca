import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import type {
  GitHistoryOptions,
  GitHistoryResult
} from '../../../../shared/git/history/git-history-types'
import { getHistory, getHistoryRefs } from '../../../git/source-control/history'
import type { GitBlameResult } from '../../../../shared/git/blame/git-blame-types'
import { getBlame } from '../../../git/source-control/blame/git-blame-read'
import { validateGitRelativeFilePath } from '../../../filesystem/local-file-io/filesystem-path-containment'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { readWorktreeGitUnlessWslStopped } from './wsl-gated-worktree-git-read'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'

export function registerFilesystemGitHistoryHandlers(
  { store }: FilesystemHandlerContext,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle(
    'git:refs',
    async (_event, args: { worktreePath: string; connectionId?: string; query?: string }) => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        false,
        (worktreePath, gitOptions) => getHistoryRefs(worktreePath, args.query, gitOptions)
      )
    }
  )

  ipc.handle(
    'git:history',
    async (
      _event,
      args: {
        worktreePath: string
        connectionId?: string
        /** Refresh: a user act that may start a stopped WSL distro. */
        wakeWslDistro?: boolean
      } & GitHistoryOptions
    ): Promise<GitHistoryResult> => {
      const options: GitHistoryOptions = {
        limit: args.limit,
        baseRef: args.baseRef,
        branchOnly: args.branchOnly,
        branchListOnly: args.branchListOnly,
        refs: args.refs,
        historyToken: args.historyToken,
        skip: args.skip
      }
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        args.wakeWslDistro,
        (worktreePath, gitOptions) => getHistory(worktreePath, { ...options, ...gitOptions })
      )
    }
  )

  ipc.handle(
    'git:blame',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        knownHeadOid?: string
        connectionId?: string
      }
    ): Promise<GitBlameResult> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      // Passive: never wakes a stopped WSL distro.
      return readWorktreeGitUnlessWslStopped(
        store,
        args.worktreePath,
        false,
        (worktreePath, gitOptions) =>
          getBlame(
            worktreePath,
            validateGitRelativeFilePath(worktreePath, args.filePath),
            gitOptions,
            args.knownHeadOid
          )
      )
    }
  )
}
