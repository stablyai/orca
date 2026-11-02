import { ipcMain } from 'electron'
import { prefetchWorktreeCreateBase } from '../../../worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../../../worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../../../project-runtime-git-options'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { blockedWslDistroForPath } from '../../../wsl/wsl-unc-access-gate'

export function registerWorktreePrefetchHandler(context: WorktreeIpcContext): void {
  const { store, runtime } = context

  ipcMain.handle(
    'worktrees:prefetchCreateBase',
    async (_event, args: { repoId: string; baseBranch?: string }): Promise<void> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return
      }
      try {
        const gitOptions = getWorktreeCreatePrefetchGitOptions(store, repo)
        // Speculative: a composer opening is no act on the repo's WSL distro (E9).
        if (await blockedWslDistroForPath(repo.path, gitOptions.wslDistro)) {
          return
        }
        await prefetchWorktreeCreateBase({
          repo,
          baseBranch: args.baseBranch,
          runtime,
          gitOptions,
          prepareCheckout: (base, beforeMaterialization) =>
            prepareWorktreeCreateForRepo(store, repo, base, beforeMaterialization)
        })
      } catch {
        // Speculative failure is reported by the real create path when it retries this refresh.
      }
    }
  )
}
