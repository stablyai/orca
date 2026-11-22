import { applyClaudeEnvPatch } from '../../claude-accounts/runtime-auth/environment'
import { getSelectedClaudeAccountIdForTarget } from '../../claude-accounts/selection/runtime-selection'
import { normalizeCodexRuntimeSelection } from '../../codex-accounts/account-management/runtime-selection'
import type { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import type { CodexRuntimeHomeService } from '../../codex-accounts/runtime-home-service'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import { DEFAULT_POLL_MS } from '../../rate-limits/service/service-types'
import type { Store } from '../../persistence/loading-store/store'
import {
  getSystemCodexHomePath,
  syncSystemCodexResourcesIntoManagedHome
} from '../../codex/configuration/homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../../codex/configuration/settings/codex-config-mirror'
import { resolveLocalAccountRuntimeTarget } from '../../../shared/agent-accounts/local-account-runtime'
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../../shared/agent-accounts/claude/claude-profile-routing'
import { resolveHostOwnedSetting } from '../../../shared/settings/host-owned-settings'
import type {
  InactiveAccountUsage,
  ProviderRateLimits
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { CommitMessageAgentEnvironmentResolvers } from './commit-message-agent-environment'
import type { TextAccountFailover } from '../source-control-text-generation-types'

type HostTextAccountFailoverDeps = {
  store: Pick<Store, 'getSettings'>
  claudeRuntimeAuth: Pick<ClaudeRuntimeAuthService, 'router'>
  codexRuntimeHome: Pick<CodexRuntimeHomeService, 'resolveCodexManagedAccountHomeForInactiveFetch'>
  rateLimits: Pick<
    RateLimitService,
    'getState' | 'fetchInactiveClaudeAccountsOnOpen' | 'fetchInactiveCodexAccountsOnOpen'
  >
}

/** Percent left in the tightest window of a fresh reading of this account; null when unknown or spent. */
function textAccountRoomLeft(
  reading: ProviderRateLimits | null | undefined,
  accountId: string,
  now = Date.now()
): number | null {
  const reader = reading?.usageMetadata?.readingAccount?.accountId
  if (
    !reading ||
    reading.status !== 'ok' ||
    reading.error ||
    now - reading.updatedAt > DEFAULT_POLL_MS ||
    (reader !== undefined && reader !== accountId)
  ) {
    return null
  }
  const windows = [reading.session, reading.weekly, reading.monthly].filter((window) => !!window)
  // A window past its reset makes the whole reading outdated.
  if (!windows.length || windows.some((w) => w.resetsAt !== null && w.resetsAt <= now)) {
    return null
  }
  // Spent windows with paid overage still count as spent: a retry never bills extra usage.
  const room = Math.min(...windows.map((window) => 100 - window.usedPercent))
  return room > 0 ? room : null
}

function rankByRoomLeft(ids: string[], usage: InactiveAccountUsage[]): string[] {
  const now = Date.now()
  return ids
    .map((id) => ({
      id,
      room: textAccountRoomLeft(usage.find((u) => u.accountId === id)?.rateLimits, id, now)
    }))
    .filter((entry): entry is { id: string; room: number } => entry.room !== null)
    .sort((a, b) => b.room - a.room || a.id.localeCompare(b.id))
    .map((entry) => entry.id)
}

/** Builds the host's failover for one request; each request refreshes inactive usage at most once. */
export function createHostTextAccountFailover(
  deps: HostTextAccountFailoverDeps
): NonNullable<CommitMessageAgentEnvironmentResolvers['prepareTextAccountFailover']> {
  const enabled = (): boolean => {
    const settings = deps.store.getSettings()
    return (
      resolveHostOwnedSetting(settings, 'textGenerationSubscriptionFailoverEnabled') &&
      resolveLocalAccountRuntimeTarget(settings).runtime === 'host'
    )
  }
  return (agentId, baseEnv) => {
    if (!enabled()) {
      return undefined
    }
    const settings = deps.store.getSettings()
    const router = deps.claudeRuntimeAuth.router
    const provider =
      agentId === 'claude'
        ? {
            initialAccountId: getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' }),
            candidates: () =>
              deps.store
                .getSettings()
                .claudeManagedAccounts.filter(
                  (account) =>
                    account.authMethod === 'subscription-oauth' &&
                    account.managedAuthRuntime !== 'wsl' &&
                    !router.coveredBySystemDefault(account.id)
                )
                .map((account) => account.id),
            usage: async () => (await deps.rateLimits.getState()).inactiveClaudeAccounts,
            refresh: () => deps.rateLimits.fetchInactiveClaudeAccountsOnOpen(),
            environment: async (accountId: string) => {
              const home = await router.prepareAccount(accountId)
              return applyClaudeEnvPatch(
                { ...baseEnv },
                { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home }
              )
            }
          }
        : {
            initialAccountId: normalizeCodexRuntimeSelection(settings).host,
            candidates: () =>
              deps.store
                .getSettings()
                .codexManagedAccounts.filter((account) => account.managedHomeRuntime !== 'wsl')
                .map((account) => account.id),
            usage: async () => (await deps.rateLimits.getState()).inactiveCodexAccounts,
            refresh: () => deps.rateLimits.fetchInactiveCodexAccountsOnOpen(),
            environment: async (accountId: string) => {
              const account = deps.store
                .getSettings()
                .codexManagedAccounts.find((candidate) => candidate.id === accountId)
              const home = account
                ? deps.codexRuntimeHome.resolveCodexManagedAccountHomeForInactiveFetch(account)
                : null
              if (home?.kind !== 'ready') {
                return null
              }
              // Same resources and config a chat launch on this account gets.
              syncSystemCodexResourcesIntoManagedHome(home.homePath)
              syncSystemConfigIntoManagedCodexHome({
                runtimeHomePath: home.homePath,
                systemHomePath: getSystemCodexHomePath()
              })
              return { ...baseEnv, CODEX_HOME: home.homePath }
            }
          }
    let refreshed = false
    const unusable = new Set<string>()
    const failover: TextAccountFailover = {
      initialAccountId: provider.initialAccountId,
      next: async (tried) => {
        for (;;) {
          if (!enabled()) {
            return null
          }
          const ids = provider
            .candidates()
            .filter((id) => id !== provider.initialAccountId && !tried.has(id) && !unusable.has(id))
          for (const accountId of rankByRoomLeft(ids, await provider.usage())) {
            const env = await provider.environment(accountId).catch(() => null)
            if (env) {
              return { accountId, env }
            }
            unusable.add(accountId)
          }
          if (refreshed || !ids.length) {
            return null
          }
          refreshed = true
          await provider.refresh()
        }
      }
    }
    return failover
  }
}
