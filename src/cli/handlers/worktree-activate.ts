import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRequiredWorktreeSelector } from '../selectors'
import { folderIdOfSelector } from '../../shared/workspace-scope'
import { refuseFolderWorkspaceActivation } from './folder-workspace-mutations'

export const WORKTREE_ACTIVATE_HANDLERS: Record<string, CommandHandler> = {
  // Opening a workspace is the request that wakes a sleeping recipe VM behind it (#36923).
  'worktree activate': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    const folderId = folderIdOfSelector(worktree)
    if (folderId !== undefined) {
      refuseFolderWorkspaceActivation(folderId)
    }
    const result = await client.call<{ worktreeId: string }>('worktree.activate', {
      worktree,
      // A paired caller's default is its own view; the CLI opens the workspace on its host.
      navigation: 'host'
    })
    printResult(result, json, ({ worktreeId }) => `Activated ${worktreeId}`)
  }
}
