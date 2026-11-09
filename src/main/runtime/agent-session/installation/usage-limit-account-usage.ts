import { agentSessionAccountHomePath } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { CLAUDE_AUTH_ENV_VARS } from '../../../claude-accounts/environment'
import type { RateLimitService } from '../../../rate-limits/service/rate-limit-service'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'

type AccountUsageReader = NonNullable<
  NonNullable<StructuredAgentSessionHostDeps['usageLimitAutoContinue']>['accountUsage']
>

/** Billing that bypasses the account's subscription windows, so its reading says nothing. */
const CLAUDE_NON_SUBSCRIPTION_ENV = [
  ...CLAUDE_AUTH_ENV_VARS,
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]

/** Orca's managed account behind a reading; a different login in the same home changes it. Null
 *  for System Default, where nothing on main names the login a reading saw. */
function readingIdentity(
  provider: 'claude' | 'codex',
  reading: { home: string; provenance: string },
  settings: Partial<Pick<GlobalSettings, 'claudeManagedAccounts' | 'codexManagedAccounts'>>
): string | null {
  if (provider === 'claude') {
    const id = /^profile:([^:]+)$/.exec(reading.provenance)?.[1]
    const account = (settings.claudeManagedAccounts ?? []).find((candidate) => candidate.id === id)
    return account ? JSON.stringify([account.id, account.email, account.organizationUuid]) : null
  }
  const home = normalizeRuntimePathForComparison(reading.home)
  const account = (settings.codexManagedAccounts ?? []).find(
    (candidate) =>
      (candidate.managedHomeRuntime ?? 'host') === 'host' &&
      normalizeRuntimePathForComparison(candidate.managedHomePath) === home
  )
  return account ? JSON.stringify([account.id, account.email, account.providerAccountId]) : null
}

/** Attributes a chat's launch home to the selected account's polled reading only when that reading
 *  was taken in the same home; anything else is no evidence. */
export function usageLimitAccountUsage(deps: {
  rateLimits: () => RateLimitService | null
  settings: () => Partial<Pick<GlobalSettings, 'claudeManagedAccounts' | 'codexManagedAccounts'>>
  claudeLaunchEnvironment: () => Promise<Record<string, string | undefined>>
}): AccountUsageReader {
  return async (provider, accountHome) => {
    const path = agentSessionAccountHomePath(accountHome)
    const service = deps.rateLimits()
    if ((provider !== 'claude' && provider !== 'codex') || !path || !service) {
      return undefined
    }
    const home = normalizeRuntimePathForComparison(path)
    const describes = (reading: { home: string } | null) =>
      reading !== null && normalizeRuntimePathForComparison(reading.home) === home
    const reading = service.usageReadingAccount(provider)
    if (!reading || !describes(reading)) {
      return undefined
    }
    if (provider === 'claude') {
      const env = await deps.claudeLaunchEnvironment()
      if (CLAUDE_NON_SUBSCRIPTION_ENV.some((name) => env[name]?.trim())) {
        return undefined
      }
    }
    const identity = readingIdentity(provider, reading, deps.settings())
    return {
      key: JSON.stringify([home, identity]),
      identityKnown: identity !== null,
      read: () => {
        const current = service.usageReadingAccount(provider)
        return describes(current) && current?.provenance === reading.provenance
          ? service.getState()[provider]
          : null
      },
      refresh: () => service.requestUsageReading(provider)
    }
  }
}
