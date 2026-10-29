import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PersistedState } from '../../shared/persisted-state-types'
import { getStoreGitHubParticipants } from '../runtime/github-participant-store'
import { readSharedGitHubCache } from '../runtime/github-participant-shared-cache'

export function registerGitHubCacheHandlers(store: Store): void {
  ipcMain.handle('cache:getGitHub', () => readSharedGitHubCache(store))
  ipcMain.handle('cache:setGitHub', (_event, args: { cache: PersistedState['githubCache'] }) => {
    if (getStoreGitHubParticipants(store)?.hasEnabledRepos()) {
      return
    }
    store.setGitHubCache(args.cache)
  })
}
