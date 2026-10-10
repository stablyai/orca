import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RateLimitService } from '../rate-limits/service'
import { claudeStateFile, readClaudeFolderLogin } from './claude-account-folder'
import { savedWslClaudeAccountHome } from './claude-profile-wsl-paths'
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

export const CLAUDE_ACCOUNT_NEEDS_SIGN_IN_MESSAGE =
  'Sign in to this Claude account again before selecting it.'

export const CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE =
  "Orca couldn't delete this Claude account's folder. Quit any Claude running in this account, then remove it again."

export type ClaudeAccountSettings = Pick<
  GlobalSettings,
  | 'claudeManagedAccounts'
  | 'activeClaudeManagedAccountId'
  | 'activeClaudeManagedAccountIdsByRuntime'
>

export type ClaudeAccountStore = {
  getSettings: () => ClaudeAccountSettings
  updateSettings: (
    patch: Partial<ClaudeAccountSettings>,
    options?: { notifyListeners?: boolean }
  ) => unknown
}

export type ClaudeAccountRuntime = Pick<
  ClaudeRuntimeAuthService,
  'syncForCurrentSelection' | 'publishAll' | 'removeAccountFolder' | 'prepareAccountFolder'
> & {
  router: Pick<
    ClaudeRuntimeAuthService['router'],
    'accountHome' | 'userConfigDir' | 'copiedLoginIntoSystemDefault' | 'coveredBySystemDefault'
  >
}

export type ClaudeAccountUsage = Pick<
  RateLimitService,
  'evictInactiveClaudeCache' | 'refreshForClaudeAccountChange'
>

export class ClaudeAccountSelection {
  constructor(
    private readonly store: ClaudeAccountStore,
    private readonly rateLimits: ClaudeAccountUsage,
    private readonly runtimeAuth: ClaudeAccountRuntime
  ) {}

  /** Each row is labelled with the login its folder holds (superset U/profiles.ts:121-137). */
  list(): ClaudeRateLimitAccountsState {
    this.pruneSelection()
    const settings = this.store.getSettings()
    const selection = normalizeClaudeRuntimeSelection(settings)
    const accounts = settings.claudeManagedAccounts
      .map((account) => this.summarize(account))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const userConfigDir = this.runtimeAuth.router.userConfigDir()
    // Why only with accounts, and at most every 5 s: the personal state file is large and every
    // running Claude rewrites it, so a list would otherwise re-parse it on main each time.
    const systemDefault =
      accounts.length > 0 ? readClaudeFolderLogin(claudeStateFile(userConfigDir), 5_000) : null
    return {
      accounts,
      activeAccountId: selection.host,
      activeAccountIdsByRuntime: selection,
      ...(systemDefault ? { systemDefaultEmail: systemDefault.email } : {}),
      ...(systemDefault && this.runtimeAuth.router.copiedLoginIntoSystemDefault()
        ? { systemDefaultMayBeCopied: true }
        : {})
    }
  }

  private summarize(account: ClaudeManagedAccount): ClaudeManagedAccountSummary {
    const summary: ClaudeManagedAccountSummary = {
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
    if (account.managedAuthRuntime === 'wsl') {
      // Why no read: listing must not start a stopped distro. Only an older Orca's folder layout
      // is known to hold no login; a launch refuses a missing folder with its own reason.
      return savedWslClaudeAccountHome(account) ? summary : { ...summary, needsSignIn: true }
    }
    const login = readClaudeFolderLogin(
      claudeStateFile(this.runtimeAuth.router.accountHome(account.id))
    )
    if (login) {
      return {
        ...summary,
        email: login.email,
        organizationUuid: login.organizationUuid,
        organizationName: login.organizationName
      }
    }
    // Why: an account System default is signed in to runs there until it signs in on its own.
    return this.runtimeAuth.router.coveredBySystemDefault(account.id)
      ? summary
      : { ...summary, needsSignIn: true }
  }

  async remove(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const target = getClaudeSelectionTargetForAccount(account)
    const wasSelected = getSelectedClaudeAccountIdForTarget(settings, target) === accountId
    const nextSelection = removeClaudeAccountIdFromSelection(
      normalizeClaudeRuntimeSelection(settings),
      accountId
    )
    this.saveSettings({
      activeClaudeManagedAccountId:
        settings.activeClaudeManagedAccountId === accountId ? null : nextSelection.host,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    // Why before the delete: no new launch may pick the folder while it is being removed.
    await this.runtimeAuth.syncForCurrentSelection(target)
    try {
      await this.runtimeAuth.removeAccountFolder(accountId, target)
    } catch (error) {
      // Why keep the row: the folder (on Windows, with its history) is still there to retry.
      console.warn('[claude-accounts] Could not delete the account folder:', error)
      throw new Error(CLAUDE_ACCOUNT_FOLDER_IN_USE_MESSAGE)
    }
    this.saveSettings({
      claudeManagedAccounts: this.store
        .getSettings()
        .claudeManagedAccounts.filter((entry) => entry.id !== accountId)
    })
    // Why again: the last account's removal also removes the which-account file.
    await this.runtimeAuth.syncForCurrentSelection(target)
    this.rateLimits.evictInactiveClaudeCache(accountId)
    this.refreshUsage(wasSelected ? accountId : undefined, target)
    return this.list()
  }

  async select(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    let effectiveTarget = target
    if (accountId !== null) {
      const account = this.requireAccount(accountId)
      const accountTarget = getClaudeSelectionTargetForAccount(account)
      const requested = normalizeClaudeAccountSelectionTarget(target ?? accountTarget)
      const owned = normalizeClaudeAccountSelectionTarget(accountTarget)
      if (
        requested.runtime !== owned.runtime ||
        (requested.wslDistro !== null && requested.wslDistro !== owned.wslDistro)
      ) {
        throw new Error('That Claude account belongs to a different runtime.')
      }
      // Why on the host: the CLI and paired clients select without the renderer's check.
      if (this.summarize(account).needsSignIn) {
        throw new Error(CLAUDE_ACCOUNT_NEEDS_SIGN_IN_MESSAGE)
      }
      effectiveTarget = accountTarget
    }
    const previous = this.store.getSettings()
    const outgoingAccountId = getSelectedClaudeAccountIdForTarget(previous, effectiveTarget)
    const nextSelection = setSelectedClaudeAccountIdForTarget(
      normalizeClaudeRuntimeSelection(previous),
      accountId,
      effectiveTarget
    )
    this.saveSettings({
      activeClaudeManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    try {
      await this.runtimeAuth.syncForCurrentSelection(effectiveTarget)
    } catch (error) {
      this.saveSettings({
        activeClaudeManagedAccountId: previous.activeClaudeManagedAccountId,
        activeClaudeManagedAccountIdsByRuntime: previous.activeClaudeManagedAccountIdsByRuntime
      })
      await this.runtimeAuth.publishAll().catch((rollbackError: unknown) => {
        console.warn('[claude-accounts] Rollback republish failed:', rollbackError)
      })
      throw error
    }
    this.refreshUsage(outgoingAccountId, effectiveTarget)
    return this.list()
  }

  /** Bookkeeping: a usage failure never undoes the account change that triggered it. */
  refreshUsage(
    outgoingAccountId: string | null | undefined,
    target: ClaudeAccountSelectionTarget | undefined
  ): void {
    void this.rateLimits
      .refreshForClaudeAccountChange(outgoingAccountId ?? undefined, target)
      .catch((error: unknown) =>
        console.warn('[claude-accounts] Usage unavailable after account change:', error)
      )
  }

  findAccount(accountId: string): ClaudeManagedAccount | undefined {
    return this.store.getSettings().claudeManagedAccounts.find((entry) => entry.id === accountId)
  }

  requireAccount(accountId: string): ClaudeManagedAccount {
    const account = this.findAccount(accountId)
    if (!account) {
      throw new Error('That Claude account no longer exists.')
    }
    return account
  }

  // Why notify: every window's switcher and Settings read the selection from settings, including
  // selections made by the CLI, a paired client or another window.
  saveSettings(patch: Partial<ClaudeAccountSettings>): void {
    this.store.updateSettings(patch, { notifyListeners: true })
  }

  private pruneSelection(): void {
    const settings = this.store.getSettings()
    const current = normalizeClaudeRuntimeSelection(settings)
    const next = pruneInvalidClaudeRuntimeSelection(current, settings.claudeManagedAccounts)
    if (
      next.host !== settings.activeClaudeManagedAccountId ||
      JSON.stringify(next) !== JSON.stringify(current)
    ) {
      this.store.updateSettings({
        activeClaudeManagedAccountId: next.host,
        activeClaudeManagedAccountIdsByRuntime: next
      })
    }
  }
}
