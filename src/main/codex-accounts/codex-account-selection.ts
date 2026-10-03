import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState,
  CodexSystemDefaultIdentity
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { CodexConfigMirror } from './codex-config-mirror'
import type { CodexAccountServiceLifecycle } from './codex-account-service-types'
import { toCodexManagedAccountSummary } from './codex-account-service-types'
import { reconcileCodexAccountRemoval } from './codex-account-removal-reconciliation'
import {
  getCodexSelectionLaneKey,
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexAccountSelectionTarget,
  normalizeCodexRuntimeSelection,
  pruneInvalidCodexRuntimeSelection,
  removeCodexAccountIdFromSelection,
  setSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'

type CodexAccountSelectionDependencies = {
  store: Store
  rateLimits: RateLimitService
  runtimeHome: CodexRuntimeHomeService
  configMirror: CodexConfigMirror
  lifecycle: CodexAccountServiceLifecycle
  resolveSystemDefault: () => CodexSystemDefaultIdentity
  removeManagedHome: (candidatePath: string, expectedAccountId: string) => boolean
  persistAccountRemoval: (
    accountId: string,
    updates: Parameters<Store['updateCodexAccountSettingsAndFlush']>[0]
  ) => Promise<void>
}

export class CodexAccountSelection {
  constructor(private readonly dependencies: CodexAccountSelectionDependencies) {}

  list(): CodexRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.snapshot()
  }

  snapshot(): CodexRateLimitAccountsState {
    const settings = this.dependencies.store.getSettings()
    const accountIds = new Set(settings.codexManagedAccounts.map((account) => account.id))
    const recovery = (settings.codexAccountRemovalRecovery ?? [])
      .filter((account) => !accountIds.has(account.id))
      .map((account) => ({ ...toCodexManagedAccountSummary(account), removalPending: true }))
    return {
      accounts: [
        ...settings.codexManagedAccounts.map(toCodexManagedAccountSummary),
        ...recovery
      ].sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: normalizeCodexRuntimeSelection(settings).host,
      activeAccountIdsByRuntime: normalizeCodexRuntimeSelection(settings),
      systemDefault: this.dependencies.resolveSystemDefault()
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
    const settings = this.dependencies.store.getSettings()
    const account =
      settings.codexManagedAccounts.find((entry) => entry.id === accountId) ??
      settings.codexAccountRemovalRecovery?.find((entry) => entry.id === accountId) ??
      this.requireAccount(accountId)
    const accountTarget = getCodexSelectionTargetForAccount(account)
    const nextAccounts = settings.codexManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = pruneInvalidCodexRuntimeSelection(
      removeCodexAccountIdFromSelection(normalizeCodexRuntimeSelection(settings), accountId),
      nextAccounts
    )

    const settingsUpdate = {
      codexManagedAccounts: nextAccounts,
      activeCodexManagedAccountId: nextSelection.host,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    }
    const touchedTargets = new Map<string, CodexAccountSelectionTarget>()
    try {
      const reconciledUpdate = this.dependencies.store.withCodexAccountSettingsPreview(
        settingsUpdate,
        () =>
          reconcileCodexAccountRemoval(
            this.dependencies.store,
            (target) => {
              touchedTargets.set(getCodexSelectionLaneKey(target), target)
              this.dependencies.runtimeHome.syncForCurrentSelection(target)
            },
            accountTarget,
            normalizeCodexRuntimeSelection(settings)
          )
      )
      // Retain the target before the destructive commit, so restart can retry lost acknowledgements.
      await this.dependencies.store.retainCodexAccountRemovalRecoveryAndFlush(account)
      await this.dependencies.persistAccountRemoval(accountId, reconciledUpdate)
    } catch (error) {
      for (const target of touchedTargets.values()) {
        try {
          this.dependencies.runtimeHome.syncForCurrentSelection(target)
        } catch (rollbackError) {
          console.error(
            '[codex-accounts] Failed to restore runtime after account removal rollback:',
            rollbackError
          )
        }
      }
      throw error
    }
    const committedHost = normalizeCodexRuntimeSelection(this.dependencies.store.getSettings()).host
    if (
      committedHost === null &&
      (account.managedHomeRuntime !== 'wsl' ||
        normalizeCodexRuntimeSelection(settings).host !== null)
    ) {
      try {
        this.dependencies.lifecycle.onHostSystemDefaultSelected?.()
      } catch (error) {
        console.error(
          '[codex-accounts] Failed to reconcile host lifecycle after account removal:',
          error
        )
      }
    }

    if (this.dependencies.removeManagedHome(account.managedHomePath, account.id)) {
      await this.dependencies.store.clearCodexAccountRemovalRecoveryAndFlush(account.id)
    }
    // Why: a removed account can no longer appear in the switcher dropdown,
    // so purge its cached usage to avoid stale entries.
    try {
      this.dependencies.rateLimits.evictInactiveCodexCache(accountId)
    } catch (error) {
      console.error('[codex-accounts] Failed to evict removed account quota cache:', error)
    }
    this.startQuotaRefresh(
      getSelectedCodexAccountIdForTarget(settings, accountTarget) === accountId
        ? accountId
        : undefined,
      accountTarget
    )
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
    this.dependencies.store.updateSettings({
      activeCodexManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    })
    this.dependencies.configMirror.safeSyncToManagedHomes()
    this.dependencies.runtimeHome.syncForCurrentSelection(effectiveTarget)
    if (
      accountId === null &&
      normalizeCodexAccountSelectionTarget(effectiveTarget).runtime === 'host'
    ) {
      this.dependencies.lifecycle.onHostSystemDefaultSelected?.()
    }

    this.startQuotaRefresh(outgoingAccountId, effectiveTarget)
    return this.snapshot()
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
    const logFailure = (error: unknown): void => {
      console.error('[codex-accounts] Quota refresh after account change failed:', error)
    }
    try {
      void this.dependencies.rateLimits
        .refreshForCodexAccountChange(outgoingAccountId, target)
        .catch(logFailure)
    } catch (error) {
      logFailure(error)
    }
  }
}
