import { ipcMain } from 'electron'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type {
  RateLimitRuntimeTarget,
  RuntimeTargetUsageProvider
} from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CodexAccountService } from '../codex-accounts/service'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/selection/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/account-management/runtime-selection'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'

export function registerRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService,
  getSettings: () => GlobalSettings,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('rateLimits:get', () => rateLimits.getState())
  ipc.handle('rateLimits:refresh', () => rateLimits.refresh())
  ipc.handle('rateLimits:refreshOnOwnerReturn', () => rateLimits.refreshOnOwnerReturn())
  ipc.handle('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  // Why: managed desktop resets must share the mobile mutation queue and durable ledger.
  ipc.handle('rateLimits:consumeCodexResetCredit', () =>
    codexAccounts.consumeCurrentRateLimitResetCredit()
  )
  ipc.handle('rateLimits:refreshClaudeForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshClaudeForTarget(target)
  )
  ipc.handle('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  ipc.handle('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
  ipc.handle('rateLimits:refreshGrok', () => rateLimits.refreshGrok())
  // Why: a focused WSL host's distro usage is read without switching the desktop's own target.
  ipc.handle(
    'rateLimits:readUsageForRuntimeTarget',
    (_event, target: RateLimitRuntimeTarget, providers: RuntimeTargetUsageProvider[]) =>
      rateLimits.readUsageForRuntimeTarget(target, providers, () => {
        const settings = getSettings()
        return {
          claude: getSelectedClaudeAccountIdForTarget(settings, target),
          codex: getSelectedCodexAccountIdForTarget(settings, target)
        }
      })
  )
}
