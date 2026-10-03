import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'
import { describeClaudeAccountIdentityRefusal } from '../../shared/claude-account-refusal-copy'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import {
  getClaudeSelectionTargetForAccount,
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  normalizeClaudeRuntimeSelection,
  removeClaudeAccountIdFromSelection,
  setSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { isUnfinishedClaudeSignIn } from '../../shared/claude-unfinished-sign-in'

type SelectionSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

export class ClaudeAccountSelection {
  constructor(
    private readonly store: {
      getSettings: () => SelectionSettings
      updateSettings: (
        patch: Partial<SelectionSettings>,
        options?: { notifyListeners?: boolean }
      ) => unknown
    },
    private readonly rateLimits: Pick<
      RateLimitService,
      'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'
    >,
    private readonly runtimeAuth: Pick<
      ClaudeRuntimeAuthService,
      'syncForCurrentSelection' | 'forceMaterializeCurrentSelectionForRollback'
    >
  ) {}

  list(): ClaudeRateLimitAccountsState {
    const profiles = getClaudeProfileRoutingAuthority()
    if (!profiles) {
      return this.snapshot()
    }
    const described = profiles.describeAccounts(this.snapshot())
    const now = Date.now()
    // Why: a login that finished after Orca stopped waiting (or quit) needs no second sign-in.
    const completed = described.accounts.flatMap((summary) => {
      const identity =
        isUnfinishedClaudeSignIn(summary) && summary.profileEmail && !summary.profileIdentityIssue
          ? profiles.observedIdentity(summary.id)
          : null
      const account = identity ? this.findAccount(summary.id) : undefined
      return identity && account
        ? [
            {
              ...account,
              email: identity.email,
              organizationUuid: identity.organizationUuid,
              organizationName: identity.organizationName,
              authMethod: 'subscription-oauth' as const,
              updatedAt: now,
              lastAuthenticatedAt: now
            }
          ]
        : []
    })
    if (completed.length === 0) {
      return described
    }
    const ids = new Set(completed.map((account) => account.id))
    this.writeSettings({
      claudeManagedAccounts: [
        ...this.store.getSettings().claudeManagedAccounts.filter((entry) => !ids.has(entry.id)),
        ...completed
      ]
    })
    return profiles.describeAccounts(this.snapshot())
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
    this.writeSettings({
      claudeManagedAccounts: nextAccounts,
      activeClaudeManagedAccountId: nextActiveId,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    await this.syncRuntimeAuthAfterRemoval(target)
    this.rateLimits.evictInactiveClaudeCache(accountId)
    this.refreshUsageInBackground(wasSelected ? accountId : undefined, target)
    return this.list()
  }

  async select(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    let effectiveTarget = target
    if (accountId !== null) {
      const account = this.requireAccount(accountId)
      const described = this.list().accounts.find((entry) => entry.id === accountId)
      if (described?.profileIdentityIssue) {
        throw new Error(
          describeClaudeAccountIdentityRefusal(described.profileIdentityIssue, {
            addedAs: described.email,
            signedInAs: described.profileEmail ?? described.email
          })
        )
      }
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
    this.writeSettings({
      activeClaudeManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    try {
      await this.syncRuntimeAuth(effectiveTarget)
    } catch (error) {
      this.restoreSettings(previousSettings)
      await this.rollBackRuntimeAuth(effectiveTarget ?? { runtime: 'host' })
      throw error
    }
    this.refreshUsageInBackground(outgoingAccountId, effectiveTarget)
    return this.list()
  }

  /** Bookkeeping: a usage failure never undoes the account change that triggered it. */
  refreshUsageInBackground(
    outgoingAccountId: string | null | undefined,
    target: ClaudeAccountSelectionTarget | undefined
  ): void {
    void this.rateLimits
      .refreshForClaudeAccountChange(outgoingAccountId ?? undefined, target)
      .catch((error) =>
        console.warn('[claude-profile] Usage unavailable after account change:', error)
      )
  }

  // Why: a distro that no longer exists has no pointer anyone can launch, so its bookkeeping must
  // not block removing its accounts. Only the profile transport reports a missing distro.
  private async syncRuntimeAuthAfterRemoval(target: ClaudeAccountSelectionTarget): Promise<void> {
    try {
      await this.syncRuntimeAuth(target)
    } catch (error) {
      console.warn('[claude-profile] Removed account; pointer repair failed:', error)
    }
  }

  // Why caught with profiles: a rollback failure must not replace the error that caused it.
  async rollBackRuntimeAuth(target: ClaudeAccountSelectionTarget): Promise<void> {
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

  private findAccount(accountId: string): ClaudeManagedAccount | undefined {
    return this.store.getSettings().claudeManagedAccounts.find((entry) => entry.id === accountId)
  }

  requireAccount(accountId: string): ClaudeManagedAccount {
    const account = this.findAccount(accountId)
    if (!account) {
      throw new Error('That Claude account no longer exists.')
    }
    return account
  }

  restoreSettings(settings: SelectionSettings): void {
    this.writeSettings({
      claudeManagedAccounts: settings.claudeManagedAccounts,
      activeClaudeManagedAccountId: settings.activeClaudeManagedAccountId,
      activeClaudeManagedAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime
    })
  }

  // Why notify: every window's switcher and Settings read the selection from settings, including
  // selections made by the CLI, a paired client or another window.
  private writeSettings(patch: Partial<SelectionSettings>): void {
    this.store.updateSettings(patch, { notifyListeners: true })
  }

  async syncRuntimeAuth(
    target?: ClaudeAccountSelectionTarget,
    operation?: () => Promise<void>
  ): Promise<void> {
    // Why no launch gate: launches read the settings selection, and the pointer queue orders publishes.
    await (operation ? operation() : this.runtimeAuth.syncForCurrentSelection(target, 'boot'))
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
