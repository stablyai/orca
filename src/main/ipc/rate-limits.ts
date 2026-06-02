import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitRuntimeTarget } from '../../shared/rate-limit-types'

export function registerRateLimitHandlers(rateLimits: RateLimitService): void {
  ipcMain.handle('rateLimits:get', () => rateLimits.getState())
  ipcMain.handle('rateLimits:refresh', () => rateLimits.refresh())
  ipcMain.handle('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  ipcMain.handle('rateLimits:refreshClaudeForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshClaudeForTarget(target)
  )
  ipcMain.handle('rateLimits:setPollingInterval', (_event, ms: number) =>
    rateLimits.setPollingInterval(ms)
  )
  ipcMain.handle('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
}
