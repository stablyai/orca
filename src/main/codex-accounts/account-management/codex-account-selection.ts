import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../../shared/agent-accounts/managed-account-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { Store } from '../../persistence/loading-store/store'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'
import type { CodexRuntimeHomeService } from '../runtime-home-service'
import type { CodexConfigMirror } from '../managed-homes/codex-config-mirror'
import type { CodexAuthIdentity as ResolvedCodexIdentity } from '../credentials/codex-auth-identity'
import { codexAuthIdentityContradictsAccount } from '../credentials/codex-auth-identity'
import type { CodexAccountServiceLifecycle } from './codex-account-service-types'
import { toCodexManagedAccountSummary } from './codex-account-service-types'
import {
  normalizeManagedAccountDisplayName,
  withManagedAccountDisplayName
} from '../../../shared/agent-accounts/managed-account-display-names'
import {
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexRuntimeSelection,
  pruneInvalidCodexRuntimeSelection,
  removeCodexAccountIdFromSelection,
  setSelectedCodexAccountIdForTarget
} from './runtime-selection'
import {
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/agent-accounts/codex/codex-selection-lane'
import { hostSystemDefaultUsageId } from '../../../shared/agent-accounts/host-system-default-usage'

type CodexAccountSelectionDependencies = {
  store: Store
  rateLimits: RateLimitService
  runtimeHome: CodexRuntimeHomeService
  configMirror: CodexConfigMirror
  lifecycle: CodexAccountServiceLifecycle
  resolveSystemDefault: () => Promise<CodexSystemDefaultIdentity>
  /** Host homes only: `list` reads them synchronously, and never a WSL home. */
  readIdentityFromHostHome: (
    managedHomePath: string,
    expectedAccountId: string
  ) => ResolvedCodexIdentity
  removeManagedHome: (candidatePath: string, expectedAccountId: string) => Promise<void>
  discardResetAttempts: (accountId: string) => Promise<void>
}

export class CodexAccountSelection {
  constructor(private readonly dependencies: CodexAccountSelectionDependencies) {}

  async list(): Promise<CodexRateLimitAccountsState> {
    this.normalizeActiveSelection()
    this.adoptManagedHomeIdentities()
    return this.snapshot()
  }

  async snapshot(): Promise<CodexRateLimitAccountsState> {
    const settings = this.dependencies.store.getSettings()
    return {
      accounts: settings.codexManagedAccounts
        .map((account) =>
          toCodexManagedAccountSummary(account, settings.managedAccountDisplayNames)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: normalizeCodexRuntimeSelection(settings).host,
      activeAccountIdsByRuntime: normalizeCodexRuntimeSelection(settings),
      systemDefault: await this.dependencies.resolveSystemDefault()
    }
  }

  requireAccount(accountId: string): CodexManagedAccount {
    const account = this.dependencies.store
      .getSettings()
      .codexManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Codex rate limit account no longer exists.')
    }
    return account
  }

  async remove(accountId: string): Promise<CodexRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.dependencies.store.getSettings()
    const nextAccounts = settings.codexManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = removeCodexAccountIdFromSelection(
      normalizeCodexRuntimeSelection(settings),
      accountId
    )
    const nextActiveId =
      settings.activeCodexManagedAccountId === accountId ? null : nextSelection.host
    const names = withManagedAccountDisplayName(
      settings.managedAccountDisplayNames,
      'codex',
      accountId,
      null
    )

    this.saveSettings({
      codexManagedAccounts: nextAccounts,
      activeCodexManagedAccountId: nextActiveId,
      activeCodexManagedAccountIdsByRuntime: nextSelection,
      ...(names ? { managedAccountDisplayNames: names } : {})
    })
    this.dependencies.runtimeHome.syncForCurrentSelection()
    if (account.managedHomeRuntime === 'host' && nextSelection.host === null) {
      this.dependencies.lifecycle.onHostSystemDefaultSelected?.()
    }

    await this.dependencies.removeManagedHome(account.managedHomePath, account.id)
    this.dependencies.rateLimits.evictInactiveCodexCache(accountId)
    try {
      await this.dependencies.discardResetAttempts(accountId)
    } catch (error) {
      // Removal already succeeded; retain the ledger's safety guards if cleanup fails.
      console.warn('[codex-accounts] Removed account, but credit ledger cleanup failed:', error)
    }
    const accountTarget = getCodexSelectionTargetForAccount(account)
    this.startQuotaRefresh(
      getSelectedCodexAccountIdForTarget(settings, accountTarget) === accountId
        ? accountId
        : undefined,
      accountTarget
    )
    return this.snapshot()
  }

  /** Names only; the account's record, home and selection stay untouched. */
  async rename(
    accountId: string,
    displayName: string | null
  ): Promise<CodexRateLimitAccountsState> {
    this.requireAccount(accountId)
    const names = withManagedAccountDisplayName(
      this.dependencies.store.getSettings().managedAccountDisplayNames,
      'codex',
      accountId,
      normalizeManagedAccountDisplayName(displayName)
    )
    if (names) {
      this.saveSettings({ managedAccountDisplayNames: names })
    }
    return this.snapshot()
  }

  async select(
    accountId: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    let effectiveTarget = target
    if (accountId !== null) {
      const accountTarget = getCodexSelectionTargetForAccount(this.requireAccount(accountId))
      const requestedTarget = normalizeCodexAccountSelectionTarget(target ?? accountTarget)
      const normalizedAccountTarget = normalizeCodexAccountSelectionTarget(accountTarget)
      if (
        requestedTarget.runtime !== normalizedAccountTarget.runtime ||
        (requestedTarget.wslDistro !== null &&
          requestedTarget.wslDistro !== normalizedAccountTarget.wslDistro)
      ) {
        throw new Error('That Codex account belongs to a different runtime.')
      }
      effectiveTarget = accountTarget
    }

    const previousSettings = this.dependencies.store.getSettings()
    const outgoingAccountId = getSelectedCodexAccountIdForTarget(previousSettings, effectiveTarget)
    const nextSelection = setSelectedCodexAccountIdForTarget(
      normalizeCodexRuntimeSelection(previousSettings),
      accountId,
      effectiveTarget
    )
    this.saveSettings({
      activeCodexManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    })
    await this.dependencies.configMirror.safeSyncToManagedHomes()
    this.dependencies.runtimeHome.syncForCurrentSelection(effectiveTarget)
    if (
      accountId === null &&
      normalizeCodexAccountSelectionTarget(effectiveTarget).runtime === 'host'
    ) {
      this.dependencies.lifecycle.onHostSystemDefaultSelected?.()
    }

    // Keep System default's last reading on its row, as an outgoing saved account's is kept.
    this.startQuotaRefresh(
      outgoingAccountId ?? hostSystemDefaultUsageId('codex', effectiveTarget),
      effectiveTarget
    )
    return this.snapshot()
  }

  // Notify every window of changes made by the CLI, paired clients, or other windows.
  saveSettings(patch: Partial<GlobalSettings>): void {
    this.dependencies.store.updateSettings(patch, { notifyListeners: true })
  }

  // A `codex login` run inside a managed home swaps its account; label the row with what actually runs (#22284).
  private adoptManagedHomeIdentities(): void {
    const settings = this.dependencies.store.getSettings()
    let changed = false
    const accounts = settings.codexManagedAccounts.map((account) => {
      // WSL homes are read over UNC, which can block when the distro is stopped.
      if (account.managedHomeRuntime === 'wsl' || parseWslUncPath(account.managedHomePath)) {
        return account
      }
      let identity: ResolvedCodexIdentity
      try {
        identity = this.dependencies.readIdentityFromHostHome(account.managedHomePath, account.id)
      } catch {
        return account
      }
      if (!identity.email || !codexAuthIdentityContradictsAccount(identity, account)) {
        return account
      }
      console.warn(
        '[codex-accounts] Managed home holds a different Codex login; updating its label'
      )
      changed = true
      return {
        ...account,
        email: identity.email,
        providerAccountId: identity.providerAccountId,
        workspaceLabel: identity.workspaceLabel,
        workspaceAccountId: identity.workspaceAccountId,
        updatedAt: Date.now()
      }
    })
    if (changed) {
      this.dependencies.store.updateSettings({ codexManagedAccounts: accounts })
    }
  }

  private normalizeActiveSelection(): void {
    const settings = this.dependencies.store.getSettings()
    const selection = normalizeCodexRuntimeSelection(settings)
    const nextSelection = pruneInvalidCodexRuntimeSelection(
      selection,
      settings.codexManagedAccounts
    )
    const changed =
      nextSelection.host !== selection.host ||
      JSON.stringify(nextSelection.wsl) !== JSON.stringify(selection.wsl)
    if (!changed) {
      return
    }
    this.dependencies.store.updateSettings({
      activeCodexManagedAccountId: nextSelection.host,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    })
    if (selection.host !== null && nextSelection.host === null) {
      this.dependencies.lifecycle.onHostSystemDefaultSelected?.()
    }
  }

  private startQuotaRefresh(
    outgoingAccountId: string | null | undefined,
    target: CodexAccountSelectionTarget | undefined
  ): void {
    void this.dependencies.rateLimits
      .refreshForCodexAccountChange(outgoingAccountId, target)
      .catch((error) => {
        console.error('[codex-accounts] Quota refresh after account change failed:', error)
      })
  }
}
