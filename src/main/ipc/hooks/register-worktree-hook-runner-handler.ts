import { ipcMain } from 'electron'
import {
  createIssueCommandRunnerScript,
  resolveSetupRunnerShell
} from '../../worktree-runner-script'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

export function registerWorktreeHookRunnerHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:createIssueCommandRunner',
    (_event, args: { repoId: string; worktreePath: string; command: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }

      return createIssueCommandRunnerScript(
        repo,
        args.worktreePath,
        args.command,
        getLocalProjectWorktreeGitOptions(store, repo),
        resolveSetupRunnerShell(store.getSettings())
      )
    }
  )
}
