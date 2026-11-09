import { agentSessionAccountHomePath } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { BoundedMap } from '../../../../shared/bounded-map'
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

/** One comparable spelling per folder: `~`, dot segments and symlinks (`/var` → `/private/var`)
 *  name the same home. Comparison only; credential reads keep the raw spelling. */
function canonicalHomes(): (raw: string) => Promise<string> {
  const resolved = new BoundedMap<string, string>({ maxEntries: 64 })
  return async (raw) => {
    const known = resolved.get(raw)
    if (known !== undefined) {
      return known
    }
    const expanded = /^~(?=$|[\\/])/.test(raw) ? join(homedir(), raw.slice(1)) : raw
    const absolute = resolve(expanded)
    // A missing folder stays uncached so it is followed once it exists.
    const real = await realpath(absolute).catch(() => null)
    const canonical = normalizeRuntimePathForComparison(real ?? absolute)
    if (real !== null) {
      resolved.set(raw, canonical)
    }
    return canonical
  }
}

/** Attributes a chat's launch home to the selected account's polled reading only when that reading
 *  was taken in the same home; anything else is no evidence. */
export function usageLimitAccountUsage(deps: {
  rateLimits: () => RateLimitService | null
  settings: () => Partial<Pick<GlobalSettings, 'claudeManagedAccounts' | 'codexManagedAccounts'>>
  claudeLaunchEnvironment: () => Promise<Record<string, string | undefined>>
}): AccountUsageReader {
  const canonical = canonicalHomes()
  return async (provider, accountHome) => {
    const path = agentSessionAccountHomePath(accountHome)
    const service = deps.rateLimits()
    if ((provider !== 'claude' && provider !== 'codex') || !path || !service) {
      return undefined
    }
    const home = await canonical(path)
    if (provider === 'claude') {
      const env = await deps.claudeLaunchEnvironment()
      if (CLAUDE_NON_SUBSCRIPTION_ENV.some((name) => env[name]?.trim())) {
        return { scope: JSON.stringify([home, 'non-subscription']) }
      }
    }
    const scope = JSON.stringify([home, 'subscription'])
    const reading = service.usageReadingAccount(provider)
    if (!reading) {
      // No reading has said where it was taken yet (a headless start polls nothing on its own).
      return { scope, bootstrap: () => service.requestUsageReading(provider) }
    }
    if ((await canonical(reading.home)) !== home) {
      return { scope }
    }
    const identity = readingIdentity(provider, reading, deps.settings())
    return {
      scope,
      account: {
        key: JSON.stringify([home, identity]),
        identityKnown: identity !== null,
        read: () => {
          const current = service.usageReadingAccount(provider)
          return current?.home === reading.home && current.provenance === reading.provenance
            ? service.usageReading(provider)
            : null
        },
        refresh: () => service.requestUsageReading(provider)
      }
    }
  }
}
