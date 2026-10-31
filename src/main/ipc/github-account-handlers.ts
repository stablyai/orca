import { ipcMain } from 'electron'
import { appStarSourceSchema } from '../../shared/gh-star-source'
import { resolveGhAccountRequiredHost } from '../github/account-binding-required-host'
import { diagnoseGhAuth } from '../github/auth-diagnose'
import { checkOrcaStarred, getAuthenticatedViewer, starOrca } from '../github/client'
import {
  listGhAccountBindingInventory,
  validateGhAccountBinding
} from '../github/gh-account-binding-inventory'
import { getRateLimit } from '../github/rate-limit'
import type { Store } from '../persistence'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { track } from '../telemetry/client'
import { assertRegisteredGitHubRepo, getGitHubLocalGitOptionArgs } from './github-repo-routing'

export function registerGitHubAccountHandlers(store: Store): void {
  ipcMain.handle('gh:viewer', () => getAuthenticatedViewer())
  ipcMain.handle('gh:checkOrcaStarred', () => checkOrcaStarred())
  ipcMain.handle('gh:starOrca', async (_event, source: unknown) => {
    const sourceParse = appStarSourceSchema.safeParse(source)
    const starred = await starOrca()
    if (starred && sourceParse.success) {
      track('app_starred_orca', {
        source: sourceParse.data,
        ...getCohortAtEmit()
      })
    }
    return starred
  })

  ipcMain.handle('gh:rateLimit', (_event, args?: { force?: boolean }) =>
    getRateLimit(args?.force ? { force: true } : undefined)
  )

  ipcMain.handle('gh:diagnoseAuth', (_event, args?: { host?: string }) =>
    diagnoseGhAuth(args?.host)
  )

  ipcMain.handle(
    'gh:listBindableAccounts',
    async (_event, args: { repoPath: string; repoId?: string; refreshCapability?: boolean }) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0] ?? {}
      const requiredHost = await resolveGhAccountRequiredHost(repo, localGitOptions)
      return listGhAccountBindingInventory(localGitOptions, {
        refreshCapability: args.refreshCapability === true,
        ...(requiredHost ? { requiredHost } : {})
      })
    }
  )

  ipcMain.handle(
    'gh:validateAccountBinding',
    async (_event, args: { repoPath: string; repoId?: string; host: string; user: string }) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0] ?? {}
      const requiredHost = await resolveGhAccountRequiredHost(repo, localGitOptions)
      return validateGhAccountBinding(
        { host: args.host, user: args.user },
        localGitOptions,
        requiredHost ? { requiredHost } : {}
      )
    }
  )
}
