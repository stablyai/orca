import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'

/** Register Grok account status IPC against the runtime-aware rate-limit service. */
export function registerGrokAccountHandlers(rateLimits: RateLimitService): void {
  ipcMain.handle('grokAccounts:getStatus', () => rateLimits.getGrokAccountStatus())
}
