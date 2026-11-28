import { HOST_SYSTEM_DEFAULT_USAGE_IDS } from '../../shared/agent-accounts/host-system-default-usage'
import type { CodexManagedAccount } from '../../shared/agent-accounts/managed-account-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/account-management/runtime-selection'
import { getSystemCodexHomePath } from '../codex/configuration/homes/codex-home-paths'
import {
  inactiveCodexHomeUnlessStopped,
  type ResolvedCodexManagedHome
} from './inactive-codex-home'
import type { InactiveCodexAccountInfo } from './service/service-types'

const codexHostSystemDefaultUsage: InactiveCodexAccountInfo = {
  id: HOST_SYSTEM_DEFAULT_USAGE_IDS.codex,
  resolveHome: () => ({
    kind: 'ready',
    managedHomePath: getSystemCodexHomePath(),
    backendUsageOnly: true
  })
}

/** Unselected Codex logins to preview, plus the host System default while a saved host account is selected. */
export function resolveInactiveCodexAccounts(
  settings: Pick<
    GlobalSettings,
    'codexManagedAccounts' | 'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
  >,
  resolveManagedHome: (account: CodexManagedAccount) => ResolvedCodexManagedHome
): InactiveCodexAccountInfo[] {
  const selection = normalizeCodexRuntimeSelection(settings)
  const activeIds = new Set([selection.host, ...Object.values(selection.wsl)].filter(Boolean))
  const inactive = settings.codexManagedAccounts
    .filter((account) => !activeIds.has(account.id))
    .map((account) => ({
      id: account.id,
      ...(account.managedHomeRuntime === 'wsl'
        ? account.wslDistro
          ? {
              readingAccount: {
                accountId: account.id,
                runtime: 'wsl' as const,
                wslDistro: account.wslDistro
              }
            }
          : {}
        : {
            readingAccount: { accountId: account.id, runtime: 'host' as const, wslDistro: null }
          }),
      resolveHome: () => inactiveCodexHomeUnlessStopped(resolveManagedHome(account))
    }))
  // First, so its HTTP read starts alongside the first saved account's app-server probe.
  return selection.host ? [codexHostSystemDefaultUsage, ...inactive] : inactive
}
