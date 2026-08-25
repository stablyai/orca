import { ipcMain } from 'electron'
import { appStarSourceSchema } from '../../shared/gh-star-source'
import { diagnoseGhAuth } from '../github/auth-diagnose'
import { checkOrcaStarred, getAuthenticatedViewer, starOrca } from '../github/client'
import { getRateLimit } from '../github/rate-limit'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { track } from '../telemetry/client'

export function registerGitHubAccountHandlers(): void {
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
}
