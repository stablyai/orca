import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS
} from '../../shared/windows-transient-lock-removal'
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

const REAUTH_STAGING_DIR_NAME = '.orca-reauth-login'

function removeStagingHome(stagingHomePath: string): void {
  rmSync(stagingHomePath, {
    recursive: true,
    force: true,
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  })
}

export class CodexAccountRegistration {
  constructor(private readonly dependencies: CodexAccountRegistrationDependencies) {}

  async add(
    target?: CodexAccountAddTarget,
    login: (managedHomePath: string) => Promise<void> = this.dependencies.login
  ): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHome = await this.dependencies.managedHomes.create(accountId, target)
    const { managedHomePath } = managedHome
    try {
      this.prepareManagedHomeForLogin(managedHomePath, accountId)
      await login(managedHomePath)
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
    // Capture activation intent before login; background polling can clear selection while OAuth is open.
    const activateAfterLogin =
      options?.activateIfSelectionWasEmpty === true && selectedAccountId === null

    this.dependencies.configMirror.safeSyncIntoManagedHome(managedHomePath, undefined, account.id)
    await this.loginThroughStagingHome(managedHomePath, account.id)
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

    // Restore this runtime's selection while retaining current validation of other runtimes.
    this.dependencies.store.updateSettings({
      codexManagedAccounts: updatedAccounts,
      activeCodexManagedAccountId: activeSelection.host,
      activeCodexManagedAccountIdsByRuntime: activeSelection
    })
    this.dependencies.configMirror.safeSyncToManagedHomes()
    this.dependencies.runtimeHome.clearLastWrittenAuthJson(accountId)
    this.dependencies.runtimeHome.syncForCurrentSelection(accountTarget)
    // Reauthentication can change identity, so refresh quota without reusing the old account cache.
    this.startQuotaRefresh(undefined, accountTarget)
    return this.dependencies.selection.snapshot()
  }

  // `codex login` revokes and deletes the home's current auth first, so only a finished login may replace it (#10795).
  private async loginThroughStagingHome(managedHomePath: string, accountId: string): Promise<void> {
    const stagingHomePath = join(managedHomePath, REAUTH_STAGING_DIR_NAME)
    removeStagingHome(stagingHomePath)
    mkdirSync(stagingHomePath, { recursive: true })
    try {
      // Carry forced-workspace and credential-store settings into the login.
      copyFileSync(join(managedHomePath, 'config.toml'), join(stagingHomePath, 'config.toml'))
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
    try {
      await this.dependencies.login(stagingHomePath)
      this.dependencies.managedHomes.importAuthFromHome(stagingHomePath, managedHomePath, accountId)
    } finally {
      try {
        removeStagingHome(stagingHomePath)
      } catch (error) {
        console.warn('[codex-accounts] Failed to remove reauthentication staging home:', error)
      }
    }
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
      this.dependencies.runtimeHome.syncForCurrentSelection(targetSelection)
    } catch (error) {
      // Restore settings before caller cleanup removes the failed account's home.
      this.dependencies.store.updateSettings({
        codexManagedAccounts: settings.codexManagedAccounts,
        activeCodexManagedAccountId: settings.activeCodexManagedAccountId,
        activeCodexManagedAccountIdsByRuntime: settings.activeCodexManagedAccountIdsByRuntime
      })
      // Restore runtime auth to match the reverted persisted selection.
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
    // Cache outgoing usage without delaying the already-persisted account addition.
    this.startQuotaRefresh(outgoingAccountId, targetSelection)
    return this.dependencies.selection.snapshot()
  }

  private startQuotaRefresh(
    outgoingAccountId: string | null | undefined,
    target: CodexAccountSelectionTarget | undefined
  ): void {
    // Slow quota probes must not delay or fail an already-persisted account change.
    void this.dependencies.rateLimits
      .refreshForCodexAccountChange(outgoingAccountId, target)
      .catch((error) => {
        console.error('[codex-accounts] Quota refresh after account change failed:', error)
      })
  }
}
