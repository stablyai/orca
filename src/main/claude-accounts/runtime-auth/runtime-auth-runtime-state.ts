import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from '../keychain'
import { ClaudeRuntimeAuthKeychainSnapshots } from './runtime-auth-keychain-snapshots'
import {
  RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR,
  type ClaudeKeychainSnapshotValue
} from './runtime-auth-types'

export class ClaudeRuntimeAuthRuntimeState extends ClaudeRuntimeAuthKeychainSnapshots {
  protected readRuntimeCredentialsFile(): string | null {
    const credentialsPath = this.pathResolver.getRuntimePaths().credentialsPath
    return existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : null
  }

  protected runtimeCredentialsBelongToAccount(
    credentialsJson: string | null,
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown
  ): boolean {
    if (!credentialsJson) {
      return false
    }
    const identity = this.readIdentityFromCredentials(credentialsJson)
    if (
      !identity?.email ||
      (account.email && this.normalizeField(account.email) !== identity.email)
    ) {
      return false
    }
    const oauthIdentity = this.readIdentityFromOauthAccount(managedOauthAccount)
    const selectedOrganizationUuid = this.normalizeField(
      account.organizationUuid ?? oauthIdentity.organizationUuid
    )
    if (selectedOrganizationUuid) {
      return identity.organizationUuid === selectedOrganizationUuid
    }
    return !identity.organizationUuid
  }

  protected clearLastWrittenRuntimeState(): void {
    this.lastWrittenCredentialsJson = null
    this.lastWrittenOauthAccount = null
    this.hasLastWrittenOauthAccount = false
    this.hasMaterializedRuntimeAuth = false
  }

  protected hasUnchangedRuntimeCredentials(
    previouslyWrittenCredentialsJson: string | null
  ): boolean {
    if (previouslyWrittenCredentialsJson === null) {
      return false
    }
    const paths = this.pathResolver.getRuntimePaths()
    const currentCredentialsJson = existsSync(paths.credentialsPath)
      ? readFileSync(paths.credentialsPath, 'utf-8')
      : null
    return currentCredentialsJson === previouslyWrittenCredentialsJson
  }

  protected runtimeCredentialsChangedSinceLastWrite(baselineCredentialsJson: string): boolean {
    const paths = this.pathResolver.getRuntimePaths()
    try {
      const currentCredentialsJson = existsSync(paths.credentialsPath)
        ? readFileSync(paths.credentialsPath, 'utf-8')
        : null
      return (
        currentCredentialsJson !== null &&
        currentCredentialsJson !== (this.lastWrittenCredentialsJson ?? baselineCredentialsJson)
      )
    } catch {
      return false
    }
  }

  protected restoreRuntimeCredentials(credentialsJson: string | null): void {
    const paths = this.pathResolver.getRuntimePaths()
    if (credentialsJson !== null) {
      this.writeRuntimeCredentials(credentialsJson)
    } else {
      rmSync(paths.credentialsPath, { force: true })
    }
  }

  protected restoreRuntimeOauthAccountIfOwned(
    oauthAccount: unknown,
    ownedOauthAccount: unknown,
    options: { allowCredentialSurfaceOwnership: boolean }
  ): void {
    const currentOauthAccount = this.readRuntimeOauthAccount()
    if (currentOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR) {
      return
    }
    if (options.allowCredentialSurfaceOwnership) {
      this.writeRuntimeOauthAccount(oauthAccount)
      return
    }
    if (
      (ownedOauthAccount === null || ownedOauthAccount === undefined) &&
      !options.allowCredentialSurfaceOwnership
    ) {
      return
    }
    if (!this.jsonValuesEqual(currentOauthAccount, ownedOauthAccount)) {
      return
    }
    this.writeRuntimeOauthAccount(oauthAccount)
  }

  protected async hasUnchangedActiveClaudeKeychainCredentials(
    snapshotValue: ClaudeKeychainSnapshotValue,
    previouslyWrittenCredentialsJson: string | null,
    configDir?: string
  ): Promise<boolean> {
    if (snapshotValue.status === 'unknown') {
      return false
    }
    const currentCredentialsJson =
      await this.readActiveClaudeKeychainCredentialsBestEffort(configDir)
    return (
      previouslyWrittenCredentialsJson !== null &&
      currentCredentialsJson === previouslyWrittenCredentialsJson
    )
  }

  protected async restoreActiveClaudeKeychainCredentials(
    credentialsJson: string | null,
    configDir?: string
  ): Promise<void> {
    await (credentialsJson !== null
      ? writeActiveClaudeKeychainCredentials(credentialsJson, configDir)
      : deleteActiveClaudeKeychainCredentialsStrict(configDir))
  }

  protected async hasActiveKeychainCredentialsForAccount(
    account: ClaudeManagedAccount,
    managedOauthAccount: unknown,
    configDir?: string
  ): Promise<boolean> {
    const currentCredentialsJson =
      await this.readActiveClaudeKeychainCredentialsBestEffort(configDir)
    return this.runtimeCredentialsBelongToAccount(
      currentCredentialsJson,
      account,
      managedOauthAccount
    )
  }

  protected readRuntimeOauthAccount(): unknown {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    if (!existsSync(configPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown
      const record = this.asRecord(parsed)
      if (!record) {
        return RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR
      }
      return record.oauthAccount ?? null
    } catch {
      return RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR
    }
  }

  protected runtimeOauthAccountMatches(managedOauthAccount: unknown): boolean {
    if (managedOauthAccount === null || managedOauthAccount === undefined) {
      return false
    }
    const currentOauthAccount = this.readRuntimeOauthAccount()
    if (currentOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR) {
      return false
    }
    return this.jsonValuesEqual(currentOauthAccount, managedOauthAccount)
  }

  protected writeRuntimeOauthAccount(oauthAccount: unknown): boolean {
    const configPath = this.pathResolver.getRuntimePaths().configPath
    const existing = this.readJsonObject(configPath)
    if (existing === null) {
      return false
    }
    if (oauthAccount === null || oauthAccount === undefined) {
      delete existing.oauthAccount
    } else {
      existing.oauthAccount = oauthAccount
    }
    this.writeJson(configPath, existing)
    return true
  }
}
