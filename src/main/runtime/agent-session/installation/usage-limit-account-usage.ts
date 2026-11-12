import { agentSessionAccountHomePath } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { nativeChatShellEnvironmentPolicy } from '../../../../shared/native-chat/native-chat-shell-environment'
import { createStructuredAgentEnvironmentResolvers } from '../environment/structured-agent-shell-environment'
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
 *  name the same home. Comparison only; credential reads keep the raw spelling. Read afresh on
 *  each call, which the sweep makes once per account per pass, so a retargeted link is followed. */
async function canonicalHome(raw: string): Promise<string> {
  const expanded = /^~(?=$|[\\/])/.test(raw) ? join(homedir(), raw.slice(1)) : raw
  const absolute = resolve(expanded)
  return normalizeRuntimePathForComparison((await realpath(absolute).catch(() => null)) ?? absolute)
}

type AccountSettings = Partial<
  Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'codexManagedAccounts'
    | 'nativeChatInheritShellEnvironment'
    | 'nativeChatShellEnvironmentVariables'
    | 'agentDefaultEnv'
  >
>

/** A source replaced, never mutated, when it changes; its identity is its version. */
type WitnessedSource =
  | AccountSettings
  | NonNullable<ReturnType<RateLimitService['usageReadingAccount']>>

export type UsageLimitAccountSourceDeps = {
  rateLimits: () => Pick<
    RateLimitService,
    'usageReadingAccount' | 'usageReading' | 'requestUsageReading'
  > | null
  /** Replaced, never mutated, on every write, so its identity names the settings it holds. */
  settings: () => AccountSettings
  /** The cached login-shell capture launches start from; never starts a shell. */
  shellEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Moves whenever that capture is replaced. */
  shellEnvironmentRevision: () => number
  /** The user's and the host account's Claude overlay, as a launch lays it over the base. */
  claudeLaunchEnv: (settings: AccountSettings) => Record<string, string>
  processEnvironment?: NodeJS.ProcessEnv
}

/** The account a chat would launch on and its polled usage, with a synchronous witness of every
 *  source that decides it: the settings snapshot, the cached shell capture, and the reading's
 *  source. An attribution counts only while the witness it was computed under still holds. */
export function usageLimitAccountSources(deps: UsageLimitAccountSourceDeps): {
  accountWitness: (provider: string) => string
  accountUsage: AccountUsageReader
} {
  const ids = new WeakMap<WitnessedSource, number>()
  let nextId = 0
  const idOf = (source: WitnessedSource | null | undefined): number => {
    if (!source) {
      return 0
    }
    let id = ids.get(source)
    if (id === undefined) {
      id = ++nextId
      ids.set(source, id)
    }
    return id
  }
  const readingSource = (provider: string) =>
    provider === 'claude' || provider === 'codex'
      ? deps.rateLimits()?.usageReadingAccount(provider)
      : null
  return {
    accountWitness: (provider) =>
      `${idOf(deps.settings())}:${deps.shellEnvironmentRevision()}:${idOf(readingSource(provider))}`,
    accountUsage: async (provider, accountHome) => {
      const path = agentSessionAccountHomePath(accountHome)
      const service = deps.rateLimits()
      if ((provider !== 'claude' && provider !== 'codex') || !path || !service) {
        return undefined
      }
      const settings = deps.settings()
      const reading = service.usageReadingAccount(provider)
      const home = await canonicalHome(path)
      if (provider === 'claude') {
        // Billing follows the env a launch computes now, through the launch's own composition.
        const environment = createStructuredAgentEnvironmentResolvers({
          prewarm: false,
          resolveEnvironment: deps.shellEnvironment,
          resolveShellEnvironmentPolicy: () => nativeChatShellEnvironmentPolicy(settings),
          resolveAgentLaunchEnv: () => deps.claudeLaunchEnv(settings),
          ...(deps.processEnvironment ? { processEnvironment: deps.processEnvironment } : {})
        })
        const env = await environment.resolveAgentEnvironment('claude')
        if (CLAUDE_NON_SUBSCRIPTION_ENV.some((name) => env[name]?.trim())) {
          return { scope: JSON.stringify([home, 'non-subscription']) }
        }
      }
      const scope = JSON.stringify([home, 'subscription'])
      if (!reading) {
        // No reading has said where it was taken yet (a headless start polls nothing on its own).
        return { scope, bootstrap: () => service.requestUsageReading(provider) }
      }
      if ((await canonicalHome(reading.home)) !== home) {
        return { scope }
      }
      const identity = readingIdentity(provider, reading, settings)
      return {
        scope,
        account: {
          key: JSON.stringify([home, identity]),
          // Only while the reading still comes from the source this attribution saw.
          read: () =>
            service.usageReadingAccount(provider) === reading
              ? service.usageReading(provider)
              : null,
          refresh: (notWithinMs) =>
            service.requestUsageReading(provider, notWithinMs === undefined ? {} : { notWithinMs })
        }
      }
    }
  }
}
