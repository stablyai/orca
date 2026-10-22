import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { ipcMain } from 'electron'
import { getRepoDialableSshTargetId, type ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { joinWorktreeRelativePath } from '../../runtime/runtime-relative-paths'
import { readIssueCommand, writeIssueCommand } from '../../issue-command-file'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'
import { assertWslMoveRepoWritable } from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'

/** Route private command overrides to the owning host without changing shared hook settings. */
export function registerWorktreeHookFileHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:readIssueCommand',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return {
          status: 'ok',
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: '',
          source: 'none' as const
        }
      }
      const connectionId = getRepoDialableSshTargetId(repo)
      if (connectionId) {
        // Why: this process serves no SSH filesystem.
        return {
          status: 'error',
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: joinWorktreeRelativePath(repo.path, '.orca/issue-command'),
          source: 'none' as const
        }
      }
      return readIssueCommand(repo.path)
    }
  )

  ipcMain.handle(
    'hooks:writeIssueCommand',
    async (_event, args: { repoId: string; content: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return
      }
      assertWslMoveRepoWritable(store, repo)
      if (getRepoDialableSshTargetId(repo)) {
        throw new Error('Remote filesystem unavailable. Reconnect the SSH target before retrying.')
      }
      await writeIssueCommand(repo.path, args.content, () =>
        getLocalProjectWorktreeGitOptions(store, repo)
      )
    }
  )
}
