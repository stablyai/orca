import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import {
  diagnoseGiteaAuth,
  getAuthenticatedViewer,
  getGiteaRateLimit
} from '../../gitea/gitea-auth-and-rate-limit'
import { registerGiteaMutationHandlers } from './gitea-mutation-handlers'
import { registerGiteaQueryHandlers } from './gitea-query-handlers'

export function registerGiteaHandlers(store: Store): void {
  ipcMain.handle('gitea:viewer', async () => getAuthenticatedViewer())
  ipcMain.handle('gitea:diagnoseAuth', async () => diagnoseGiteaAuth())
  ipcMain.handle(
    'gitea:rateLimit',
    async (_event, args?: { force?: boolean; host?: string | null }) =>
      getGiteaRateLimit({ force: Boolean(args?.force), host: args?.host ?? null })
  )
  registerGiteaQueryHandlers(store)
  registerGiteaMutationHandlers(store)
}
