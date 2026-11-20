import { registerAppHandler } from './app-registry/app-handler-registry'

import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { RateLimitRuntimeTarget } from '../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CodexAccountService } from '../codex-accounts/service'

export function registerRateLimitHandlers(
  rateLimits: RateLimitService,
  codexAccounts: CodexAccountService
): void {
  registerAppHandler('rateLimits:get', () => rateLimits.getState())
  registerAppHandler('rateLimits:refresh', () => rateLimits.refresh())
  registerAppHandler('rateLimits:refreshCodexForTarget', (_event, target: RateLimitRuntimeTarget) =>
    rateLimits.refreshCodexForTarget(target)
  )
  // Why: managed desktop resets must share the mobile mutation queue and durable ledger.
  registerAppHandler('rateLimits:consumeCodexResetCredit', () =>
    codexAccounts.consumeCurrentRateLimitResetCredit()
  )
  registerAppHandler(
    'rateLimits:refreshClaudeForTarget',
    (_event, target: RateLimitRuntimeTarget) => rateLimits.refreshClaudeForTarget(target)
  )
  registerAppHandler('rateLimits:fetchInactiveClaudeAccounts', () =>
    rateLimits.fetchInactiveClaudeAccountsOnOpen()
  )
  registerAppHandler('rateLimits:fetchInactiveCodexAccounts', () =>
    rateLimits.fetchInactiveCodexAccountsOnOpen()
  )
  registerAppHandler('rateLimits:refreshGrok', () => rateLimits.refreshGrok())
}
