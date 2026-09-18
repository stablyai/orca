import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'
import { getDevinAccountStatus } from '../devin-accounts/status'

export function registerDevinAccountHandlers(rateLimits: RateLimitService): void {
  ipcMain.handle('devinAccounts:getStatus', () =>
    getDevinAccountStatus(rateLimits.getState().devin ?? null)
  )
}
