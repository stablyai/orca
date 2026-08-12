import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'

export function registerGrokAccountHandlers(rateLimits: RateLimitService): void {
  ipcMain.handle('grokAccounts:getStatus', () => rateLimits.getGrokAccountStatus())
}
