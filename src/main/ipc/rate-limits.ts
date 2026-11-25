import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { RateLimitRuntimeTarget } from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CodexAccountService } from '../codex-accounts/service'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/selection/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/account-management/runtime-selection'

export function registerRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService,
  getSettings: () => GlobalSettings
): void {
  ipcMain.handle('rateLimits:get', () => rateLimits.getState())
  ipcMain.handle('rateLimits:refresh', () => rateLimits.refresh())
  ipcMain.handle('rateLimits:refreshOnOwnerReturn', () => rateLimits.refreshOnOwnerReturn())
  ipcMain.handle('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  // Why: managed desktop resets must share the mobile mutation queue and durable ledger.
  ipcMain.handle('rateLimits:consumeCodexResetCredit', () =>
    codexAccounts.consumeCurrentRateLimitResetCredit()
  )
  ipcMain.handle('rateLimits:refreshClaudeForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshClaudeForTarget(target)
  )
  ipcMain.handle('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
  ipcMain.handle('rateLimits:refreshGrok', () => rateLimits.refreshGrok())
  // Why: a focused WSL host's distro usage is read without switching the desktop's own target.
  ipcMain.handle(
    'rateLimits:readUsageForRuntimeTarget',
    async (_event, target: RateLimitRuntimeTarget) => {
      // Why before the read: a switch mid-read then shows as a mismatch the renderer discards.
      const settings = getSettings()
      const accounts = {
        claude: getSelectedClaudeAccountIdForTarget(settings, target),
        codex: getSelectedCodexAccountIdForTarget(settings, target)
      }
      return { accounts, rateLimits: await rateLimits.readUsageForRuntimeTarget(target) }
    }
  )
}
