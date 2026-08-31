import { randomUUID } from 'node:crypto'
import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { ResolvedCodexIdentity } from './codex-account-identity'
import type {
  CodexAccountAddTarget,
  CodexAccountReauthenticateOptions,
  ManagedCodexHomeLocation
} from './codex-account-service-types'
import type { CodexAccountSelection } from './codex-account-selection'
import type { CodexConfigMirror } from './codex-config-mirror'
import type { CodexManagedHomeLifecycle } from './codex-managed-home-lifecycle'
import type { CodexManagedHomePath } from './codex-managed-home-path'
import {
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexRuntimeSelection,
  setSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'

type CodexAccountRegistrationDependencies = {
  store: Store
  rateLimits: RateLimitService
  runtimeHome: CodexRuntimeHomeService
  readIdentityFromHome: (
    managedHomePath: string,
    expectedAccountId: string
  ) => ResolvedCodexIdentity
  selection: CodexAccountSelection
  configMirror: CodexConfigMirror
  managedHomePaths: CodexManagedHomePath
  managedHomes: CodexManagedHomeLifecycle
  login: (managedHomePath: string) => Promise<void>
}

export class CodexAccountRegistration {
  constructor(private readonly dependencies: CodexAccountRegistrationDependencies) {}

  async add(target?: CodexAccountAddTarget): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHome = await this.dependencies.managedHomes.create(accountId, target)
    const { managedHomePath } = managedHome
    try {
      this.prepareManagedHomeForLogin(managedHomePath, accountId)
      await this.dependencies.login(managedHomePath)
      return await this.persistCapturedAccount(accountId, managedHome)
    } catch (error) {
      this.dependencies.managedHomes.removeUnlessUnproven(error, managedHomePath, accountId)
      throw error
    }
  }

  async addFromHome(
    sourceHome: string,
    target?: CodexAccountAddTarget
  ): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHome = await this.dependencies.managedHomes.create(accountId, target)
    const { managedHomePath } = managedHome
    try {
      this.prepareManagedHomeForLogin(managedHomePath, accountId)
      this.dependencies.managedHomes.importAuthFromHome(sourceHome, managedHomePath, accountId)
      return await this.persistCapturedAccount(accountId, managedHome)
    } catch (error) {
      this.dependencies.managedHomes.removeUnlessUnproven(error, managedHomePath, accountId)
      throw error
    }
  }

  async reauthenticate(
    accountId: string,
    options?: CodexAccountReauthenticateOptions
  ): Promise<CodexRateLimitAccountsState> {
    const account = this.dependencies.selection.requireAccount(accountId)
    const managedHomePath =
      await this.dependencies.managedHomePaths.ensureForReauthentication(account)
    const accountTarget = getCodexSelectionTargetForAccount(account)
    const selectedAccountId = getSelectedCodexAccountIdForTarget(
      this.dependencies.store.getSettings(),
      accountTarget
    )
    // Why: decided from the pre-login capture, never a post-login read — the
    // runtime-home poll runs outside the mutation queue and can clear this lane
    // while OAuth is open, which would look like an empty selection to activate.
    const activateAfterLogin =
      options?.activateIfSelectionWasEmpty === true && selectedAccountId === null

    this.dependencies.configMirror.safeSyncIntoManagedHome(managedHomePath, undefined, account.id)
    await this.dependencies.login(managedHomePath)
    const identity = this.dependencies.readIdentityFromHome(managedHomePath, account.id)
    if (!identity.email) {
      throw new Error('Codex login completed, but Orca could not resolve the account email.')
    }

    const settings = this.dependencies.store.getSettings()
    const now = Date.now()
    const updatedAccounts = settings.codexManagedAccounts.map((entry) =>
      entry.id === accountId
        ? {
            ...entry,
            email: identity.email!,
            providerAccountId: identity.providerAccountId,
            workspaceLabel: identity.workspaceLabel,
            workspaceAccountId: identity.workspaceAccountId,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        : entry
    )
    const activeSelection = setSelectedCodexAccountIdForTarget(
      normalizeCodexRuntimeSelection(settings),
      activateAfterLogin ? accountId : selectedAccountId,
      accountTarget
    )

    // Why: login can transiently clear this runtime's selection; unrelated runtime validation must remain authoritative.
    this.dependencies.store.updateSettings({
      codexManagedAccounts: updatedAccounts,
      activeCodexManagedAccountId: activeSelection.host,
      activeCodexManagedAccountIdsByRuntime: activeSelection
    })
    this.dependencies.configMirror.safeSyncToManagedHomes()
    this.dependencies.runtimeHome.clearLastWrittenAuthJson(accountId)
    this.dependencies.runtimeHome.syncForCurrentSelection(accountTarget)
    // Why: re-auth can change the underlying Codex identity, so force a fresh read to avoid showing stale quota.
    this.startQuotaRefresh(undefined, accountTarget)
    return this.dependencies.selection.snapshot()
  }

  private prepareManagedHomeForLogin(managedHomePath: string, accountId: string): void {
    const canonicalConfig = this.dependencies.configMirror.readForManagedHome(managedHomePath)
    this.dependencies.configMirror.assertOAuthAccountAddAllowed(canonicalConfig)
    this.dependencies.configMirror.safeSyncIntoManagedHome(
      managedHomePath,
      canonicalConfig,
      accountId
    )
  }

  private async persistCapturedAccount(
    accountId: string,
    managedHome: ManagedCodexHomeLocation
  ): Promise<CodexRateLimitAccountsState> {
    const identity = this.dependencies.readIdentityFromHome(managedHome.managedHomePath, accountId)
    if (!identity.email) {
      throw new Error('Codex login completed, but Orca could not resolve the account email.')
    }
    const now = Date.now()
    const account: CodexManagedAccount = {
      id: accountId,
      email: identity.email,
      managedHomePath: managedHome.managedHomePath,
      managedHomeRuntime: managedHome.managedHomeRuntime,
      wslDistro: managedHome.wslDistro,
      wslLinuxHomePath: managedHome.wslLinuxHomePath,
      providerAccountId: identity.providerAccountId,
      workspaceLabel: identity.workspaceLabel,
      workspaceAccountId: identity.workspaceAccountId,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }

    const settings = this.dependencies.store.getSettings()
    const selection = normalizeCodexRuntimeSelection(settings)
    const targetSelection = getCodexSelectionTargetForAccount(account)
    this.dependencies.store.updateSettings({
      codexManagedAccounts: [...settings.codexManagedAccounts, account],
      activeCodexManagedAccountId: targetSelection.runtime === 'host' ? account.id : selection.host,
      activeCodexManagedAccountIdsByRuntime: setSelectedCodexAccountIdForTarget(
        selection,
        account.id,
        targetSelection
      )
    })
    try {
      this.dependencies.configMirror.safeSyncToManagedHomes()
      this.dependencies.runtimeHome.clearLastWrittenAuthJson(account.id)
      // Why: pass the account's selection target so a WSL account syncs the WSL
      // runtime home instead of the default host target.
      this.dependencies.runtimeHome.syncForCurrentSelection(targetSelection)
    } catch (error) {
      // Why: settings were already written; if a post-write step fails, restore the
      // previous account/selection so the caller's managed-home cleanup cannot leave
      // a dangling, broken managed account behind in settings.
      this.dependencies.store.updateSettings({
        codexManagedAccounts: settings.codexManagedAccounts,
        activeCodexManagedAccountId: settings.activeCodexManagedAccountId,
        activeCodexManagedAccountIdsByRuntime: settings.activeCodexManagedAccountIdsByRuntime
      })
      // Why: a failed post-write step must restore both persisted selection and
      // the runtime home it drives before the new managed home is removed.
      try {
        this.dependencies.runtimeHome.syncForCurrentSelection(targetSelection)
      } catch (rollbackError) {
        console.warn(
          '[codex-accounts] Failed to restore runtime home during rollback:',
          rollbackError
        )
      }
      throw error
    }

    const outgoingAccountId = getSelectedCodexAccountIdForTarget(settings, targetSelection)
    // Why: switching activates the new account, so cache the outgoing account's usage for the
    // switcher — in the background, since the probe must never block or fail a durable add.
    this.startQuotaRefresh(outgoingAccountId, targetSelection)
    return this.dependencies.selection.snapshot()
  }

  private startQuotaRefresh(
    outgoingAccountId: string | null | undefined,
    target: CodexAccountSelectionTarget | undefined
  ): void {
    // Why: quota probes against a cold per-account CODEX_HOME can take 10–25s
    // (RPC + PTY fallback) and queue behind an in-flight global usage refresh.
    // The refresh synchronously flips usage to "fetching" before its first await,
    // so the switcher updates immediately; the probe itself must never block or
    // fail the already-durable account mutation.
    void this.dependencies.rateLimits
      .refreshForCodexAccountChange(outgoingAccountId, target)
      .catch((error) => {
        console.error('[codex-accounts] Quota refresh after account change failed:', error)
      })
  }
}
