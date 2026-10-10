import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { getSshGitUsername, resolveLocalGitUsername } from '../../git/git-username'

export function registerRepoGitUsernameHandler(store: Store): void {
  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // Why: remote repos keep their git config on the remote host, so resolve the username there.
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return ''
      }
      return getSshGitUsername(provider, repo.path)
    }
    return resolveLocalGitUsername(repo.path)
  })
}
