import { ipcMain } from 'electron'
import { prefetchWorktreeCreateBase } from '../../../worktree-create-base-prefetch'
import { getWorktreeCreatePrefetchGitOptions } from '../../../project-runtime-git-options'
import {
  beginWorktreeCreateSpareRequest,
  requestWorktreeCreateSpare
} from '../../../worktree-create-preparation'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

export function registerWorktreePrefetchHandler(context: WorktreeIpcContext): void {
  const { store, runtime } = context

  ipcMain.handle(
    'worktrees:prefetchCreateBase',
    async (_event, args: { repoId: string; baseBranch?: string }): Promise<void> => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return
      }
      // Taken before the fetch, so a later pick outranks an earlier one whose fetch ends last.
      const spareTicket = beginWorktreeCreateSpareRequest(store, repo)
      try {
        const base = await prefetchWorktreeCreateBase({
          repo,
          baseBranch: args.baseBranch,
          runtime,
          gitOptions: getWorktreeCreatePrefetchGitOptions(store, repo)
        })
        // After the refresh settles (a failed fetch still returns the base), so the spare is built
        // at the commit the create will use. Not awaited.
        if (base && spareTicket) {
          requestWorktreeCreateSpare(store, repo, base, spareTicket)
        }
      } catch {
        // Why: optimistic warm-up; the real create path awaits the same refresh and reports failures there.
      }
    }
  )
}
