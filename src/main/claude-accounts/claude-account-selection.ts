import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import {
  beginClaudeAuthSwitch,
  endClaudeAuthSwitch,
  listClaudeExecutionAccountBindings
} from './live-pty-gate'
import type { ClaudeAccountTransitionResult } from '../../shared/claude-account-transition'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import {
  getClaudeSelectionTargetForAccount,
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  normalizeClaudeRuntimeSelection,
  pruneInvalidClaudeRuntimeSelection,
  removeClaudeAccountIdFromSelection,
  setSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'

export type ClaudeAccountSwitchResult = ClaudeAccountTransitionResult

export class ClaudeAccountSelection {
  constructor(
    private readonly store: Store,
    private readonly rateLimits: RateLimitService,
    private readonly runtimeAuth: ClaudeRuntimeAuthService,
    private readonly removeManagedAuth: (accountId: string, path: string) => Promise<void>
  ) {}

  list(): ClaudeRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.snapshot()
  }

  async remove(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.claudeManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = removeClaudeAccountIdFromSelection(
      normalizeClaudeRuntimeSelection(settings),
      accountId
    )
    const nextActiveId =
      settings.activeClaudeManagedAccountId === accountId ? null : nextSelection.host
    const target = getClaudeSelectionTargetForAccount(account)
    const wasSelected = getSelectedClaudeAccountIdForTarget(settings, target) === accountId
    try {
      if (wasSelected) {
        this.store.updateSettings({
          activeClaudeManagedAccountId: nextActiveId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        await this.syncRuntimeAuth(target)
        this.store.updateSettings({ claudeManagedAccounts: nextAccounts })
      } else {
        this.store.updateSettings({
          claudeManagedAccounts: nextAccounts,
          activeClaudeManagedAccountId: nextActiveId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        await this.syncRuntimeAuth(target)
      }
      await this.removeManagedAuth(accountId, account.managedAuthPath)
      this.rateLimits.evictInactiveClaudeCache(accountId)
      await this.rateLimits.refreshForClaudeAccountChange(
        wasSelected ? accountId : undefined,
        target
      )
      return this.snapshot()
    } catch (error) {
      this.restoreSettings(settings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  async select(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    let effectiveTarget = target
    if (accountId !== null) {
      const account = this.requireAccount(accountId)
      const accountTarget = getClaudeSelectionTargetForAccount(account)
      const requestedTarget = normalizeClaudeAccountSelectionTarget(target ?? accountTarget)
      const normalizedAccountTarget = normalizeClaudeAccountSelectionTarget(accountTarget)
      if (
        requestedTarget.runtime !== normalizedAccountTarget.runtime ||
        (requestedTarget.wslDistro !== null &&
          requestedTarget.wslDistro !== normalizedAccountTarget.wslDistro)
      ) {
        throw new Error('That Claude account belongs to a different runtime.')
      }
      effectiveTarget = accountTarget
    }
    const previousSettings = this.store.getSettings()
    const outgoingAccountId = getSelectedClaudeAccountIdForTarget(previousSettings, effectiveTarget)
    const nextSelection = setSelectedClaudeAccountIdForTarget(
      normalizeClaudeRuntimeSelection(previousSettings),
      accountId,
      effectiveTarget
    )
    this.store.updateSettings({
      activeClaudeManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    try {
      await this.syncRuntimeAuth(effectiveTarget)
      await this.rateLimits.refreshForClaudeAccountChange(outgoingAccountId, effectiveTarget)
      return this.snapshot()
    } catch (error) {
      this.restoreSettings(previousSettings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  /** Explicit transition result for callers that must render switch progress without
   * treating a failed persistence/auth sync as a successful account hot-switch. */
  async selectWithTransition(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeAccountSwitchResult> {
    const effectiveTarget =
      accountId === null
        ? target
        : getClaudeSelectionTargetForAccount(this.requireAccount(accountId))
    const previousAccountId = getSelectedClaudeAccountIdForTarget(
      this.store.getSettings(),
      effectiveTarget
    )
    try {
      const accounts = await this.select(accountId, effectiveTarget)
      const transition = this.executionTransition(effectiveTarget, accountId)
      return {
        state: 'succeeded',
        accountId,
        previousAccountId,
        accounts,
        effect: 'future_launches_only',
        ...transition
      }
    } catch (error) {
      const accounts = this.snapshot()
      const transition = this.executionTransition(effectiveTarget, previousAccountId)
      return {
        state: 'rolled_back',
        accountId,
        previousAccountId,
        accounts,
        effect: 'future_launches_only',
        ...transition,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private executionTransition(
    target: ClaudeAccountSelectionTarget | undefined,
    accountId: string | null
  ): Pick<
    ClaudeAccountTransitionResult,
    'restartRequired' | 'boundLiveExecutionCount' | 'unknownLiveExecutionCount'
  > {
    const normalized = normalizeClaudeAccountSelectionTarget(target)
    let boundLiveExecutionCount = 0
    let unknownLiveExecutionCount = 0
    for (const { binding } of listClaudeExecutionAccountBindings()) {
      if (binding.runtime !== normalized.runtime) {
        continue
      }
      if (
        normalized.runtime === 'wsl' &&
        normalized.wslDistro !== null &&
        binding.wslDistro !== normalized.wslDistro
      ) {
        continue
      }
      if (binding.accountId === undefined) {
        unknownLiveExecutionCount += 1
      } else if (binding.accountId !== accountId) {
        boundLiveExecutionCount += 1
      }
    }
    return {
      restartRequired: boundLiveExecutionCount > 0 || unknownLiveExecutionCount > 0,
      boundLiveExecutionCount,
      unknownLiveExecutionCount
    }
  }

  snapshot(): ClaudeRateLimitAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.claudeManagedAccounts
        .map(toClaudeAccountSummary)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: normalizeClaudeRuntimeSelection(settings).host,
      activeAccountIdsByRuntime: normalizeClaudeRuntimeSelection(settings)
    }
  }

  requireAccount(accountId: string): ClaudeManagedAccount {
    const account = this.store
      .getSettings()
      .claudeManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Claude account no longer exists.')
    }
    return account
  }

  restoreSettings(settings: ReturnType<Store['getSettings']>): void {
    this.store.updateSettings({
      claudeManagedAccounts: settings.claudeManagedAccounts,
      activeClaudeManagedAccountId: settings.activeClaudeManagedAccountId,
      activeClaudeManagedAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime
    })
  }

  async syncRuntimeAuth(
    target?: ClaudeAccountSelectionTarget,
    operation?: () => Promise<void>
  ): Promise<void> {
    beginClaudeAuthSwitch()
    try {
      await (operation ? operation() : this.runtimeAuth.syncForCurrentSelection(target))
    } finally {
      endClaudeAuthSwitch()
    }
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    const currentSelection = normalizeClaudeRuntimeSelection(settings)
    const nextSelection = pruneInvalidClaudeRuntimeSelection(
      currentSelection,
      settings.claudeManagedAccounts
    )
    if (
      nextSelection.host !== settings.activeClaudeManagedAccountId ||
      JSON.stringify(nextSelection) !== JSON.stringify(currentSelection)
    ) {
      this.store.updateSettings({
        activeClaudeManagedAccountId: nextSelection.host,
        activeClaudeManagedAccountIdsByRuntime: nextSelection
      })
    }
  }
}

function toClaudeAccountSummary(account: ClaudeManagedAccount): ClaudeManagedAccountSummary {
  return {
    id: account.id,
    email: account.email,
    managedAuthRuntime: account.managedAuthRuntime ?? 'host',
    wslDistro: account.wslDistro ?? null,
    authMethod: account.authMethod ?? 'unknown',
    organizationUuid: account.organizationUuid ?? null,
    organizationName: account.organizationName ?? null,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastAuthenticatedAt: account.lastAuthenticatedAt
  }
}
