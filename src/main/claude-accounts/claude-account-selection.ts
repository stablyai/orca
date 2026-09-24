import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'
import {
  beginClaudeAccountHostMutation,
  countClaudePinnedAccountUsers
} from './claude-pinned-pty-registry'
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
    return this.snapshot()
  }

  async remove(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    // Why held to the end: the managed dir and Keychain item are deleted last, outside the auth
    // queue, and a pinned launch must not seed from them in between.
    const endHostMutation = claimAccountForHostMutation(account, 'remove')
    try {
      return await this.removeClaimed(account)
    } finally {
      endHostMutation()
    }
  }

  private async removeClaimed(
    account: ClaudeManagedAccount
  ): Promise<ClaudeRateLimitAccountsState> {
    const accountId = account.id
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
    const endHostMutation =
      accountId === null
        ? null
        : claimAccountForHostMutation(this.requireAccount(accountId), 'select')
    try {
      return await this.selectClaimed(accountId, target)
    } finally {
      endHostMutation?.()
    }
  }

  private async selectClaimed(
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

// Why: selecting would materialize the account into ~/.claude and removing would delete the dir a
// pinned Claude runs from; either way one refresh token would end up in two places or none. The
// claim is one synchronous check-and-set against pinned reservations, so a launch reserving the
// account concurrently is refused instead of racing past a check that already passed.
function claimAccountForHostMutation(
  account: ClaudeManagedAccount,
  action: 'select' | 'remove'
): () => void {
  const release = beginClaudeAccountHostMutation(account.id)
  if (release) {
    return release
  }
  const users = countClaudePinnedAccountUsers(account.id)
  const terminals = users === 1 ? '1 terminal' : `${users} terminals`
  throw new Error(
    `Claude account ${account.email} is in use by ${terminals} launched with --account. Close ${users === 1 ? 'it' : 'them'} before you ${action === 'select' ? 'switch to' : 'remove'} this account.`
  )
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
