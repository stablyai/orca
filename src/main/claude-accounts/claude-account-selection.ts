import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'
import { ClaudeProfileHostMissingError } from './claude-profile-routing-owner'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'
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

export class ClaudeAccountSelection {
  constructor(
    private readonly store: Store,
    private readonly rateLimits: RateLimitService,
    private readonly runtimeAuth: ClaudeRuntimeAuthService,
    private readonly removeManagedAuth: (accountId: string, path: string) => Promise<void>
  ) {}

  list(): ClaudeRateLimitAccountsState {
    this.normalizeActiveSelection()
    const profiles = getClaudeProfileRoutingAuthority()
    return profiles ? profiles.describeAccounts(this.snapshot()) : this.snapshot()
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
      // Why one write with profiles: the outgoing-token read-back needing the account is legacy only,
      // and a distro losing its last account must already be unrouted when it syncs.
      if (wasSelected && !getClaudeProfileRoutingAuthority()) {
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
        await this.syncRuntimeAuthAfterRemoval(target)
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
      await this.rollBackRuntimeAuth(target)
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
      await this.rollBackRuntimeAuth(effectiveTarget ?? { runtime: 'host' })
      throw error
    }
  }

  // Why: a distro that no longer exists has no pointer anyone can launch, so its bookkeeping must
  // not block removing its accounts. Only the profile transport reports a missing distro.
  private async syncRuntimeAuthAfterRemoval(target: ClaudeAccountSelectionTarget): Promise<void> {
    try {
      await this.syncRuntimeAuth(target)
    } catch (error) {
      if (!(error instanceof ClaudeProfileHostMissingError)) {
        throw error
      }
      console.warn(
        '[claude-accounts] Removed an account of a WSL distro that no longer exists:',
        error
      )
    }
  }

  // Why caught with profiles: a rollback failure must not replace the error that caused it.
  async rollBackRuntimeAuth(target: ClaudeAccountSelectionTarget): Promise<void> {
    if (!getClaudeProfileRoutingAuthority()) {
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback(target)
      return
    }
    try {
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback(target)
    } catch (rollbackError) {
      console.warn('[claude-accounts] Rollback rematerialization failed:', rollbackError)
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
      await (operation ? operation() : this.runtimeAuth.syncForCurrentSelection(target, 'boot'))
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
