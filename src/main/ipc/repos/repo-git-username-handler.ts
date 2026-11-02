import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import { isFolderRepo } from '../../../shared/repo-kind'
import { resolveLocalGitUsername } from '../../git/git-username'

export function registerRepoGitUsernameHandler(store: Store): void {
  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // Why: an SSH repo's git config lives on a host this process does not serve.
    if (repo.connectionId) {
      return ''
    }
    return resolveLocalGitUsername(repo.path)
  })
}
