import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { CodexAccountService } from '../codex-accounts/service'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const RATE_LIMIT_IPC_CHANNELS = [
  'rateLimits:get',
  'rateLimits:refresh',
  'rateLimits:refreshOnOwnerReturn',
  'rateLimits:refreshCodexForTarget',
  'rateLimits:consumeCodexResetCredit',
  'rateLimits:refreshClaudeForTarget',
  'rateLimits:fetchInactiveClaudeAccounts',
  'rateLimits:fetchInactiveCodexAccounts',
  'rateLimits:refreshGrok',
  'rateLimits:readUsageForRuntimeTarget'
] as const

export function registerLazyRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService,
  getSettings: () => GlobalSettings
): void {
  registerLazyIpcHandleGroup(RATE_LIMIT_IPC_CHANNELS, async (ipc) => {
    const { registerRateLimitHandlers } = await import('./rate-limits')
    registerRateLimitHandlers(rateLimits, codexAccounts, getSettings, ipc)
  })
}
