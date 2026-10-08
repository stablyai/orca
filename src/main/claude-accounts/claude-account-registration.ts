import { randomUUID } from 'node:crypto'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { findDuplicateClaudeAccount } from './claude-duplicate-account'
import type { CapturedClaudeAuth } from './claude-auth-capture'
import type {
  ClaudeManagedAuthLocation,
  ClaudeManagedAuthSnapshot,
  ClaudeManagedAuthTarget
} from './claude-managed-auth-storage'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import {
  getClaudeSelectionTargetForAccount,
  normalizeClaudeRuntimeSelection
} from './runtime-selection'
import type { ClaudeAccountSelection } from './claude-account-selection'

type ClaudeAccountRegistrationDependencies = {
  store: Store
  rateLimits: RateLimitService
  runtimeAuth: ClaudeRuntimeAuthService
  selection: ClaudeAccountSelection
  createManagedAuth: (
    accountId: string,
    target?: ClaudeManagedAuthTarget
  ) => Promise<ClaudeManagedAuthLocation>
  assertManagedAuth: (path: string, accountId: string) => Promise<string>
  removeManagedAuth: (accountId: string, path: string) => Promise<void>
  writeManagedAuth: (accountId: string, path: string, captured: CapturedClaudeAuth) => Promise<void>
  writeCredentials: (accountId: string, path: string, value: string) => Promise<void>
  writeOauth: (accountId: string, path: string, value: unknown) => Promise<void>
  readSnapshot: (accountId: string, path: string) => Promise<ClaudeManagedAuthSnapshot>
  restoreCredentials: (
    accountId: string,
    path: string,
    snapshot: ClaudeManagedAuthSnapshot
  ) => Promise<void>
  restoreOauth: (
    accountId: string,
    path: string,
    snapshot: ClaudeManagedAuthSnapshot
  ) => Promise<void>
  login: (location: ClaudeManagedAuthLocation) => Promise<CapturedClaudeAuth>
  captureExisting: (
    configDir: string,
    previousLegacyCredentialsSha256?: string | null
  ) => Promise<CapturedClaudeAuth>
}

class DuplicateClaudeAccountError extends Error {}

export class ClaudeAccountRegistration {
  constructor(private readonly dependencies: ClaudeAccountRegistrationDependencies) {}

  async add(target?: ClaudeManagedAuthTarget): Promise<ClaudeRateLimitAccountsState> {
    const accountId = randomUUID()
    const location = await this.dependencies.createManagedAuth(accountId, target)
    const previousSettings = this.dependencies.store.getSettings()
    try {
      const captured = await this.dependencies.login(location)
      return await this.persist(accountId, location, previousSettings, captured)
    } catch (error) {
      await this.cleanupFailedAdd(accountId, location.managedAuthPath, previousSettings, error)
      throw error
    }
  }

  async addFromConfigDir(
    configDir: string,
    options?: ClaudeManagedAuthTarget & { previousLegacyCredentialsSha256?: string | null }
  ): Promise<ClaudeRateLimitAccountsState> {
    const accountId = randomUUID()
    const location = await this.dependencies.createManagedAuth(accountId, options)
    const previousSettings = this.dependencies.store.getSettings()
    try {
      const captured = await this.dependencies.captureExisting(
        configDir,
        options?.previousLegacyCredentialsSha256
      )
      return await this.persist(accountId, location, previousSettings, captured)
    } catch (error) {
      await this.cleanupFailedAdd(accountId, location.managedAuthPath, previousSettings, error)
      throw error
    }
  }

  async reauthenticate(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.dependencies.selection.requireAccount(accountId)
    const managedAuthPath = await this.dependencies.assertManagedAuth(
      account.managedAuthPath,
      accountId
    )
    const previousSettings = this.dependencies.store.getSettings()
    const previousAuth = await this.dependencies.readSnapshot(accountId, managedAuthPath)
    const captured = await this.dependencies.login({
      managedAuthPath,
      managedAuthRuntime: account.managedAuthRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
      wslLinuxAuthPath: account.wslLinuxAuthPath ?? null
    })
    if (!captured.identity.email) {
      throw new Error('Claude login completed, but Orca could not resolve the account email.')
    }

    const settings = this.dependencies.store.getSettings()
    const now = Date.now()
    const nextAccounts = settings.claudeManagedAccounts.map((entry) =>
      entry.id === accountId
        ? {
            ...entry,
            email: captured.identity.email!,
            organizationUuid: captured.identity.organizationUuid,
            organizationName: captured.identity.organizationName,
            updatedAt: now,
            lastAuthenticatedAt: now
          }
        : entry
    )
    let wroteCredentials = false
    try {
      await this.dependencies.writeOauth(accountId, managedAuthPath, captured.oauthAccount)
      await this.dependencies.writeCredentials(accountId, managedAuthPath, captured.credentialsJson)
      wroteCredentials = true
      this.dependencies.store.updateSettings({ claudeManagedAccounts: nextAccounts })
      this.dependencies.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
      this.dependencies.rateLimits.evictInactiveClaudeCache(accountId)
      const target = getClaudeSelectionTargetForAccount(account)
      await this.dependencies.selection.syncRuntimeAuth(target)
      await this.dependencies.rateLimits.refreshForClaudeAccountChange(undefined, target)
      return this.dependencies.selection.snapshot()
    } catch (error) {
      await this.rollbackReauthentication(
        accountId,
        managedAuthPath,
        previousAuth,
        previousSettings,
        nextAccounts,
        wroteCredentials
      )
      throw error
    }
  }

  private async persist(
    accountId: string,
    location: ClaudeManagedAuthLocation,
    previousSettings: ReturnType<Store['getSettings']>,
    captured: CapturedClaudeAuth
  ): Promise<ClaudeRateLimitAccountsState> {
    if (!captured.identity.email) {
      throw new Error('Claude login completed, but Orca could not resolve the account email.')
    }
    if (
      findDuplicateClaudeAccount(previousSettings.claudeManagedAccounts, {
        email: captured.identity.email,
        organizationUuid: captured.identity.organizationUuid,
        managedAuthRuntime: location.managedAuthRuntime,
        wslDistro: location.wslDistro
      })
    ) {
      throw new DuplicateClaudeAccountError('This Claude account is already added.')
    }
    await this.dependencies.writeManagedAuth(accountId, location.managedAuthPath, captured)
    const now = Date.now()
    const account: ClaudeManagedAccount = {
      id: accountId,
      email: captured.identity.email,
      managedAuthPath: location.managedAuthPath,
      managedAuthRuntime: location.managedAuthRuntime,
      wslDistro: location.wslDistro,
      wslLinuxAuthPath: location.wslLinuxAuthPath,
      authMethod: 'subscription-oauth',
      organizationUuid: captured.identity.organizationUuid,
      organizationName: captured.identity.organizationName,
      createdAt: now,
      updatedAt: now,
      lastAuthenticatedAt: now
    }
    const selection = normalizeClaudeRuntimeSelection(previousSettings)
    this.dependencies.store.updateSettings({
      claudeManagedAccounts: [...previousSettings.claudeManagedAccounts, account],
      activeClaudeManagedAccountId: selection.host,
      activeClaudeManagedAccountIdsByRuntime: selection
    })
    this.dependencies.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
    this.dependencies.rateLimits.evictInactiveClaudeCache(accountId)
    return this.dependencies.selection.snapshot()
  }

  private async cleanupFailedAdd(
    accountId: string,
    managedAuthPath: string,
    previousSettings: ReturnType<Store['getSettings']>,
    error: unknown
  ): Promise<void> {
    if (error instanceof DuplicateClaudeAccountError) {
      await this.dependencies.removeManagedAuth(accountId, managedAuthPath)
      return
    }
    this.dependencies.selection.restoreSettings(previousSettings)
    try {
      await this.dependencies.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
    } catch (rollbackError) {
      console.warn('[claude-accounts] Rollback rematerialization failed:', rollbackError)
    }
    await this.dependencies.removeManagedAuth(accountId, managedAuthPath)
  }

  private async rollbackReauthentication(
    accountId: string,
    path: string,
    snapshot: ClaudeManagedAuthSnapshot,
    previousSettings: ReturnType<Store['getSettings']>,
    nextAccounts: ClaudeManagedAccount[],
    wroteCredentials: boolean
  ): Promise<void> {
    let restoredCredentials = false
    try {
      await this.dependencies.restoreCredentials(accountId, path, snapshot)
      restoredCredentials = true
    } catch (rollbackError) {
      console.warn(
        '[claude-accounts] Failed to restore managed credentials during rollback:',
        rollbackError
      )
    }
    if (restoredCredentials || !wroteCredentials) {
      try {
        await this.dependencies.restoreOauth(accountId, path, snapshot)
      } catch (rollbackError) {
        console.warn(
          '[claude-accounts] Failed to restore managed oauth metadata during rollback:',
          rollbackError
        )
      }
    }
    if (restoredCredentials) {
      this.dependencies.selection.restoreSettings(previousSettings)
      await this.dependencies.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
    } else if (wroteCredentials) {
      this.dependencies.store.updateSettings({ claudeManagedAccounts: nextAccounts })
    } else {
      this.dependencies.selection.restoreSettings(previousSettings)
    }
  }
}
