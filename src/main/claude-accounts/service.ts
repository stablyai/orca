import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { ClaudeAccountRegistration } from './claude-account-registration'
import { ClaudeAccountSelection } from './claude-account-selection'
import {
  captureClaudeAuthFromConfigDir,
  captureClaudeAuthFromExistingConfigDir,
  readCapturedClaudeCredentials,
  type CapturedClaudeAuth
} from './claude-auth-capture'
import {
  runClaudeCommandProcess,
  type ClaudeCommandConfig,
  type ClaudeCommandOptions
} from './claude-command-process'
import { runClaudeLoginSession } from './claude-login-session'
import {
  ClaudeManagedAuthStorage,
  type ClaudeManagedAuthLocation
} from './claude-managed-auth-storage'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export type ClaudeAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type ClaudeAccountImportOptions = ClaudeAccountAddTarget & {
  previousLegacyCredentialsSha256?: string | null
}

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private cancelPendingClaudeLogin: (() => boolean) | null = null
  private readonly storage = new ClaudeManagedAuthStorage()
  private readonly selection: ClaudeAccountSelection
  private readonly registration: ClaudeAccountRegistration

  constructor(
    store: Store,
    rateLimits: RateLimitService,
    private readonly runtimeAuth: ClaudeRuntimeAuthService
  ) {
    this.selection = new ClaudeAccountSelection(store, rateLimits, runtimeAuth, (accountId, path) =>
      this.safeRemoveManagedAuth(accountId, path)
    )
    this.registration = new ClaudeAccountRegistration({
      store,
      rateLimits,
      runtimeAuth,
      selection: this.selection,
      createManagedAuth: (accountId, target) => this.storage.create(accountId, target),
      assertManagedAuth: (path, accountId) => this.storage.assertOwned(path, accountId),
      removeManagedAuth: (accountId, path) => this.safeRemoveManagedAuth(accountId, path),
      writeManagedAuth: (accountId, path, captured) =>
        this.writeManagedAuth(accountId, path, captured),
      writeCredentials: (accountId, path, value) =>
        this.storage.writeCredentials(accountId, path, value),
      writeOauth: (accountId, path, value) =>
        this.storage.writeOauthAccount(accountId, path, value),
      readSnapshot: (accountId, path) => this.storage.readSnapshot(accountId, path),
      restoreCredentials: (accountId, path, snapshot) =>
        this.storage.restoreCredentials(accountId, path, snapshot),
      restoreOauth: (accountId, path, snapshot) =>
        this.storage.restoreOauth(accountId, path, snapshot),
      login: (location) => this.runClaudeLoginAndCapture(location),
      captureExisting: (configDir, previousDigest) =>
        this.captureFromExistingConfigDir(configDir, previousDigest)
    })
  }

  listAccounts(): ClaudeRateLimitAccountsState {
    return this.selection.list()
  }

  async addAccount(target?: ClaudeAccountAddTarget): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.add(target))
  }

  async addAccountFromConfigDir(
    configDir: string,
    options?: ClaudeAccountImportOptions
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.addFromConfigDir(configDir, options))
  }

  async reauthenticateAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.registration.reauthenticate(accountId))
  }

  async removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.selection.remove(accountId))
  }

  async selectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.selection.select(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.selection.select(accountId, target))
  }

  cancelPendingLogin(): boolean {
    return this.cancelPendingClaudeLogin?.() ?? false
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.runtimeAuth.getRuntimeConfigDir(target)
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private runClaudeLoginAndCapture(
    location: ClaudeManagedAuthLocation = {
      managedAuthPath: '',
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
  ): Promise<CapturedClaudeAuth> {
    return runClaudeLoginSession(location, {
      runCommand: (args, config, timeoutMs, options) =>
        this.runClaudeCommand(args, config, timeoutMs, options),
      capture: (configDir, status, previousLegacy) =>
        this.captureAuthFromConfigDir(configDir, status, previousLegacy),
      setCancel: (cancel) => {
        this.cancelPendingClaudeLogin = cancel
      }
    })
  }

  private runClaudeCommand(
    args: string[],
    configDir: ClaudeCommandConfig,
    timeoutMs: number,
    options?: ClaudeCommandOptions
  ): Promise<string> {
    return runClaudeCommandProcess(args, configDir, timeoutMs, options)
  }

  private captureFromExistingConfigDir(
    configDir: string,
    previousLegacyCredentialsSha256?: string | null
  ): Promise<CapturedClaudeAuth> {
    return captureClaudeAuthFromExistingConfigDir(
      configDir,
      previousLegacyCredentialsSha256,
      (args, config, timeoutMs, options) => this.runClaudeCommand(args, config, timeoutMs, options)
    )
  }

  private captureAuthFromConfigDir(
    configDir: string,
    statusOutput: string,
    previousLegacyKeychain: string | null,
    previousLegacyCredentialsSha256?: string | null
  ): Promise<CapturedClaudeAuth> {
    return captureClaudeAuthFromConfigDir(
      configDir,
      statusOutput,
      previousLegacyKeychain,
      previousLegacyCredentialsSha256,
      (path, previous, digest) => this.readCapturedCredentials(path, previous, digest)
    )
  }

  private readCapturedCredentials(
    configDir: string,
    previousLegacyKeychain: string | null,
    previousLegacyCredentialsSha256?: string | null
  ): Promise<string | null> {
    return readCapturedClaudeCredentials(
      configDir,
      previousLegacyKeychain,
      previousLegacyCredentialsSha256
    )
  }

  private writeManagedAuth(
    accountId: string,
    managedAuthPath: string,
    captured: CapturedClaudeAuth
  ): Promise<void> {
    return this.storage.writeAuth(accountId, managedAuthPath, captured)
  }

  private safeRemoveManagedAuth(accountId: string, path: string): Promise<void> {
    return this.storage.remove(accountId, path)
  }
}
