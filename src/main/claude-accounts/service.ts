/* eslint-disable max-lines -- Why: Claude managed accounts need one audited owner
for login, credential capture, Keychain storage, selection, and rate-limit refresh. */
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import {
  getClaudeManagedAccountsRoot,
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from './managed-auth-path'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  deleteManagedClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { buildEncodedWslBashCommand } from '../wsl-bash-command'
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

const LOGIN_TIMEOUT_MS = 180_000
const STATUS_TIMEOUT_MS = 20_000
const MAX_COMMAND_OUTPUT_CHARS = 4_000

type ClaudeIdentity = {
  email: string | null
  organizationUuid: string | null
  organizationName: string | null
}

type CapturedClaudeAuth = {
  credentialsJson: string
  oauthAccount: unknown
  identity: ClaudeIdentity
}

type ManagedClaudeAuthSnapshot = {
  credentialsJson: string | null
  oauthAccountJson: string | null
}

export type ClaudeAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

type ManagedClaudeAuthLocation = {
  managedAuthPath: string
  managedAuthRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxAuthPath: string | null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class ClaudeAccountService {
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly rateLimits: RateLimitService,
    private readonly runtimeAuth: ClaudeRuntimeAuthService
  ) {}

  listAccounts(): ClaudeRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  async addAccount(target?: ClaudeAccountAddTarget): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doAddAccount(target))
  }

  async reauthenticateAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doReauthenticateAccount(accountId))
  }

  async removeAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doRemoveAccount(accountId))
  }

  async selectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doSelectAccount(accountId))
  }

  async selectAccountForTarget(
    accountId: string | null,
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doSelectAccount(accountId, target))
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async doAddAccount(
    target?: ClaudeAccountAddTarget
  ): Promise<ClaudeRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedAuth = this.createManagedAuthDir(accountId, target)
    const { managedAuthPath } = managedAuth
    const previousSettings = this.store.getSettings()

    try {
      const captured = await this.runClaudeLoginAndCapture(managedAuth)
      if (!captured.identity.email) {
        throw new Error('Claude login completed, but Orca could not resolve the account email.')
      }
      await this.writeManagedAuth(accountId, managedAuthPath, captured)

      const now = Date.now()
      const account: ClaudeManagedAccount = {
        id: accountId,
        email: captured.identity.email,
        managedAuthPath,
        managedAuthRuntime: managedAuth.managedAuthRuntime,
        wslDistro: managedAuth.wslDistro,
        wslLinuxAuthPath: managedAuth.wslLinuxAuthPath,
        authMethod: 'subscription-oauth',
        organizationUuid: captured.identity.organizationUuid,
        organizationName: captured.identity.organizationName,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }

      const selection = normalizeClaudeRuntimeSelection(previousSettings)
      const targetSelection = getClaudeSelectionTargetForAccount(account)
      const outgoingAccountId = getSelectedClaudeAccountIdForTarget(
        previousSettings,
        targetSelection
      )
      this.store.updateSettings({
        claudeManagedAccounts: [...previousSettings.claudeManagedAccounts, account],
        activeClaudeManagedAccountId:
          targetSelection.runtime === 'host' ? account.id : selection.host,
        activeClaudeManagedAccountIdsByRuntime: setSelectedClaudeAccountIdForTarget(
          selection,
          account.id,
          targetSelection
        )
      })
      this.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
      await this.syncRuntimeAuthWithLivePtyGate(targetSelection)
      await this.rateLimits.refreshForClaudeAccountChange(outgoingAccountId, targetSelection)
      return this.getSnapshot()
    } catch (error) {
      this.restoreClaudeSettings(previousSettings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      await this.safeRemoveManagedAuth(accountId, managedAuthPath)
      throw error
    }
  }

  private async doReauthenticateAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const managedAuthPath = this.assertManagedAuthPath(account.managedAuthPath, accountId)
    const previousSettings = this.store.getSettings()
    const previousManagedAuth = await this.readManagedAuthSnapshot(accountId, managedAuthPath)
    const captured = await this.runClaudeLoginAndCapture({
      managedAuthPath,
      managedAuthRuntime: account.managedAuthRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
      wslLinuxAuthPath: account.wslLinuxAuthPath ?? null
    })
    if (!captured.identity.email) {
      throw new Error('Claude login completed, but Orca could not resolve the account email.')
    }

    const settings = this.store.getSettings()
    const now = Date.now()
    const reauthenticatedAccounts = settings.claudeManagedAccounts.map((entry) =>
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
    let wroteManagedCredentials = false
    try {
      await this.writeManagedOauthAccount(accountId, managedAuthPath, captured.oauthAccount)
      await this.writeManagedCredentials(accountId, managedAuthPath, captured.credentialsJson)
      wroteManagedCredentials = true
      this.store.updateSettings({ claudeManagedAccounts: reauthenticatedAccounts })
      this.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
      this.rateLimits.evictInactiveClaudeCache(accountId)
      await this.syncRuntimeAuthWithLivePtyGate(getClaudeSelectionTargetForAccount(account))
      await this.rateLimits.refreshForClaudeAccountChange(
        undefined,
        getClaudeSelectionTargetForAccount(account)
      )
      return this.getSnapshot()
    } catch (error) {
      let restoredManagedCredentials = false
      try {
        await this.restoreManagedCredentialsSnapshot(
          accountId,
          managedAuthPath,
          previousManagedAuth
        )
        restoredManagedCredentials = true
      } catch (rollbackError) {
        console.warn(
          '[claude-accounts] Failed to restore managed credentials during rollback:',
          rollbackError
        )
      }
      if (restoredManagedCredentials || !wroteManagedCredentials) {
        try {
          this.restoreManagedOauthSnapshot(accountId, managedAuthPath, previousManagedAuth)
        } catch (rollbackError) {
          console.warn(
            '[claude-accounts] Failed to restore managed oauth metadata during rollback:',
            rollbackError
          )
        }
      }
      if (restoredManagedCredentials) {
        this.restoreClaudeSettings(previousSettings)
        await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      } else if (wroteManagedCredentials) {
        this.store.updateSettings({ claudeManagedAccounts: reauthenticatedAccounts })
      } else {
        this.restoreClaudeSettings(previousSettings)
      }
      throw error
    }
  }

  private async doRemoveAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.claudeManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = removeClaudeAccountIdFromSelection(
      normalizeClaudeRuntimeSelection(settings),
      accountId
    )
    const nextActiveId =
      settings.activeClaudeManagedAccountId === accountId ? null : nextSelection.host

    try {
      if (
        getSelectedClaudeAccountIdForTarget(
          settings,
          getClaudeSelectionTargetForAccount(account)
        ) === accountId
      ) {
        this.store.updateSettings({
          activeClaudeManagedAccountId: nextActiveId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        await this.syncRuntimeAuthWithLivePtyGate(getClaudeSelectionTargetForAccount(account))
        this.store.updateSettings({ claudeManagedAccounts: nextAccounts })
      } else {
        this.store.updateSettings({
          claudeManagedAccounts: nextAccounts,
          activeClaudeManagedAccountId: nextActiveId,
          activeClaudeManagedAccountIdsByRuntime: nextSelection
        })
        await this.syncRuntimeAuthWithLivePtyGate(getClaudeSelectionTargetForAccount(account))
      }
      await this.safeRemoveManagedAuth(accountId, account.managedAuthPath)
      this.rateLimits.evictInactiveClaudeCache(accountId)
      await this.rateLimits.refreshForClaudeAccountChange(
        getSelectedClaudeAccountIdForTarget(
          settings,
          getClaudeSelectionTargetForAccount(account)
        ) === accountId
          ? accountId
          : undefined,
        getClaudeSelectionTargetForAccount(account)
      )
      return this.getSnapshot()
    } catch (error) {
      this.restoreClaudeSettings(settings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  private async doSelectAccount(
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
    const selection = normalizeClaudeRuntimeSelection(previousSettings)
    const outgoingAccountId = getSelectedClaudeAccountIdForTarget(previousSettings, effectiveTarget)
    const nextSelection = setSelectedClaudeAccountIdForTarget(selection, accountId, effectiveTarget)
    this.store.updateSettings({
      activeClaudeManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeClaudeManagedAccountIdsByRuntime: nextSelection
    })
    try {
      await this.syncRuntimeAuthWithLivePtyGate(effectiveTarget)
      await this.rateLimits.refreshForClaudeAccountChange(outgoingAccountId, effectiveTarget)
      return this.getSnapshot()
    } catch (error) {
      this.restoreClaudeSettings(previousSettings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  private getSnapshot(): ClaudeRateLimitAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.claudeManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: normalizeClaudeRuntimeSelection(settings).host,
      activeAccountIdsByRuntime: normalizeClaudeRuntimeSelection(settings)
    }
  }

  private toSummary(account: ClaudeManagedAccount): ClaudeManagedAccountSummary {
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

  private requireAccount(accountId: string): ClaudeManagedAccount {
    const account = this.store
      .getSettings()
      .claudeManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Claude account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    const nextSelection = pruneInvalidClaudeRuntimeSelection(
      normalizeClaudeRuntimeSelection(settings),
      settings.claudeManagedAccounts
    )
    if (
      nextSelection.host !== settings.activeClaudeManagedAccountId ||
      JSON.stringify(nextSelection) !== JSON.stringify(normalizeClaudeRuntimeSelection(settings))
    ) {
      this.store.updateSettings({
        activeClaudeManagedAccountId: nextSelection.host,
        activeClaudeManagedAccountIdsByRuntime: nextSelection
      })
    }
  }

  private restoreClaudeSettings(settings: ReturnType<Store['getSettings']>): void {
    this.store.updateSettings({
      claudeManagedAccounts: settings.claudeManagedAccounts,
      activeClaudeManagedAccountId: settings.activeClaudeManagedAccountId,
      activeClaudeManagedAccountIdsByRuntime: settings.activeClaudeManagedAccountIdsByRuntime
    })
  }

  private async syncRuntimeAuthWithLivePtyGate(
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

  private async runClaudeLoginAndCapture(
    location: ManagedClaudeAuthLocation = {
      managedAuthPath: '',
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
  ): Promise<CapturedClaudeAuth> {
    const tempConfig = this.createTemporaryClaudeConfigDir(location)
    const previousLegacyKeychain = await readActiveClaudeKeychainCredentials()
    let captured: CapturedClaudeAuth | null = null
    let captureError: unknown = null
    let cleanupError: unknown = null
    try {
      await this.runClaudeCommand(['auth', 'login', '--claudeai'], tempConfig, LOGIN_TIMEOUT_MS)
      const status = await this.runClaudeCommand(
        ['auth', 'status', '--json'],
        tempConfig,
        STATUS_TIMEOUT_MS,
        { allowFailure: true }
      )
      captured = await this.captureAuthFromConfigDir(
        tempConfig.windowsPath,
        status,
        previousLegacyKeychain
      )
    } catch (error) {
      captureError = error
    } finally {
      if (process.platform === 'darwin') {
        try {
          await deleteActiveClaudeKeychainCredentialsStrict(tempConfig.windowsPath)
        } catch (error) {
          console.warn('[claude-accounts] Failed to clean temporary Claude Keychain item:', error)
        }
      }
      if (process.platform === 'darwin') {
        try {
          // Why: older Claude versions ignored CLAUDE_CONFIG_DIR and wrote the
          // legacy active Keychain item. Preserve that external CLI state.
          await (previousLegacyKeychain
            ? writeActiveClaudeKeychainCredentials(previousLegacyKeychain)
            : deleteActiveClaudeKeychainCredentialsStrict())
        } catch (error) {
          cleanupError = error
        }
      }
      this.removeTemporaryClaudeConfigDir(tempConfig)
    }
    if (captureError) {
      throw captureError
    }
    if (cleanupError) {
      throw cleanupError
    }
    return captured!
  }

  private createTemporaryClaudeConfigDir(location: ManagedClaudeAuthLocation): {
    windowsPath: string
    linuxPath: string | null
    wslDistro: string | null
  } {
    if (location.managedAuthRuntime !== 'wsl') {
      return {
        windowsPath: mkdtempSync(join(tmpdir(), 'orca-claude-login-')),
        linuxPath: null,
        wslDistro: null
      }
    }
    if (!location.wslDistro) {
      throw new Error('Could not resolve the active WSL distribution for Claude login.')
    }
    const linuxPath = execFileSync(
      'wsl.exe',
      [
        '-d',
        location.wslDistro,
        '--',
        'bash',
        '-lc',
        'mktemp -d "${TMPDIR:-/tmp}/orca-claude-login.XXXXXX"'
      ],
      { encoding: 'utf-8', timeout: 5000 }
    )
      .replaceAll(String.fromCharCode(0), '')
      .trim()
    if (!linuxPath.startsWith('/')) {
      throw new Error('Could not create a temporary WSL Claude login directory.')
    }
    return {
      windowsPath: toWindowsWslPath(linuxPath, location.wslDistro),
      linuxPath,
      wslDistro: location.wslDistro
    }
  }

  private removeTemporaryClaudeConfigDir(tempConfig: {
    windowsPath: string
    linuxPath: string | null
    wslDistro: string | null
  }): void {
    if (tempConfig.linuxPath && tempConfig.wslDistro) {
      try {
        execFileSync(
          'wsl.exe',
          [
            '-d',
            tempConfig.wslDistro,
            '--',
            'bash',
            '-lc',
            `rm -rf -- ${shellQuote(tempConfig.linuxPath)}`
          ],
          { encoding: 'utf-8', timeout: 5000 }
        )
      } catch {
        // Best-effort cleanup.
      }
      return
    }
    rmSync(tempConfig.windowsPath, { recursive: true, force: true })
  }

  private async captureAuthFromConfigDir(
    configDir: string,
    statusOutput: string,
    previousLegacyKeychain: string | null
  ): Promise<CapturedClaudeAuth> {
    const credentialsJson = await this.readCapturedCredentials(configDir, previousLegacyKeychain)
    if (!credentialsJson) {
      throw new Error('Claude login completed, but no OAuth credentials were captured.')
    }
    const oauthAccount = this.readOauthAccountFromConfigDir(configDir)
    const identity = this.resolveIdentity(statusOutput, oauthAccount, credentialsJson)
    return { credentialsJson, oauthAccount, identity }
  }

  private async readCapturedCredentials(
    configDir: string,
    previousLegacyKeychain: string | null
  ): Promise<string | null> {
    if (process.platform === 'darwin') {
      const scopedCredentialsJson = await readActiveClaudeKeychainCredentialsStrict(configDir)
      if (scopedCredentialsJson) {
        return scopedCredentialsJson
      }
      const legacyCredentialsJson = await readActiveClaudeKeychainCredentialsStrict()
      if (legacyCredentialsJson && legacyCredentialsJson !== previousLegacyKeychain) {
        return legacyCredentialsJson
      }
    }
    const credentialsPath = join(configDir, '.credentials.json')
    return existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf-8') : null
  }

  private readOauthAccountFromConfigDir(configDir: string): unknown {
    for (const configPath of [join(configDir, '.claude.json'), join(configDir, '.config.json')]) {
      if (!existsSync(configPath)) {
        continue
      }
      try {
        const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
        if (parsed.oauthAccount) {
          return parsed.oauthAccount
        }
      } catch {
        continue
      }
    }
    return null
  }

  private resolveIdentity(
    statusOutput: string,
    oauthAccount: unknown,
    credentialsJson: string
  ): ClaudeIdentity {
    const status = this.parseJsonObject(statusOutput)
    const oauth = this.asRecord(oauthAccount)
    const credentials = this.parseJsonObject(credentialsJson)
    const credentialOauth = this.asRecord(credentials?.claudeAiOauth)

    return {
      email: this.normalizeField(
        this.readString(status, 'email') ??
          this.readString(oauth, 'emailAddress') ??
          this.readString(oauth, 'email') ??
          this.readString(credentialOauth, 'email')
      ),
      organizationUuid: this.normalizeField(
        this.readString(status, 'organizationUuid') ??
          this.readString(status, 'organizationId') ??
          this.readString(oauth, 'organizationUuid') ??
          this.readString(oauth, 'organizationId')
      ),
      organizationName: this.normalizeField(
        this.readString(status, 'organizationName') ?? this.readString(oauth, 'organizationName')
      )
    }
  }

  private async writeManagedAuth(
    accountId: string,
    managedAuthPath: string,
    captured: CapturedClaudeAuth
  ): Promise<void> {
    await this.writeManagedCredentials(accountId, managedAuthPath, captured.credentialsJson)
    await this.writeManagedOauthAccount(accountId, managedAuthPath, captured.oauthAccount)
  }

  private async writeManagedCredentials(
    accountId: string,
    managedAuthPath: string,
    credentialsJson: string
  ): Promise<void> {
    const trustedPath = this.assertManagedAuthPath(managedAuthPath, accountId)
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(accountId, credentialsJson)
    } else {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', credentialsJson)
    }
  }

  private async writeManagedOauthAccount(
    accountId: string,
    managedAuthPath: string,
    oauthAccount: unknown
  ): Promise<void> {
    const trustedPath = this.assertManagedAuthPath(managedAuthPath, accountId)
    writeClaudeManagedAuthFile(
      trustedPath,
      'oauth-account.json',
      `${JSON.stringify(oauthAccount, null, 2)}\n`
    )
  }

  private async readManagedAuthSnapshot(
    accountId: string,
    managedAuthPath: string
  ): Promise<ManagedClaudeAuthSnapshot> {
    const trustedPath = this.assertManagedAuthPath(managedAuthPath, accountId)
    return {
      credentialsJson:
        process.platform === 'darwin'
          ? await readManagedClaudeKeychainCredentials(accountId)
          : readClaudeManagedAuthFile(trustedPath, '.credentials.json'),
      oauthAccountJson: readClaudeManagedAuthFile(trustedPath, 'oauth-account.json')
    }
  }

  private async restoreManagedCredentialsSnapshot(
    accountId: string,
    managedAuthPath: string,
    snapshot: ManagedClaudeAuthSnapshot
  ): Promise<void> {
    const trustedPath = this.assertManagedAuthPath(managedAuthPath, accountId)
    const credentialsPath = join(trustedPath, '.credentials.json')
    if (process.platform === 'darwin') {
      await (snapshot.credentialsJson !== null
        ? writeManagedClaudeKeychainCredentials(accountId, snapshot.credentialsJson)
        : deleteManagedClaudeKeychainCredentials(accountId))
    } else if (snapshot.credentialsJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, '.credentials.json', snapshot.credentialsJson)
    } else {
      rmSync(credentialsPath, { force: true })
    }
  }

  private restoreManagedOauthSnapshot(
    accountId: string,
    managedAuthPath: string,
    snapshot: ManagedClaudeAuthSnapshot
  ): void {
    const trustedPath = this.assertManagedAuthPath(managedAuthPath, accountId)
    const oauthPath = join(trustedPath, 'oauth-account.json')
    if (snapshot.oauthAccountJson !== null) {
      writeClaudeManagedAuthFile(trustedPath, 'oauth-account.json', snapshot.oauthAccountJson)
    } else {
      rmSync(oauthPath, { force: true })
    }
  }

  private createManagedAuthDir(
    accountId: string,
    target?: ClaudeAccountAddTarget
  ): ManagedClaudeAuthLocation {
    const wslAuth = this.tryCreateWslManagedAuthDir(accountId, target)
    if (wslAuth) {
      return wslAuth
    }

    const managedAuthPath = join(this.getManagedAccountsRoot(), accountId, 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
    return {
      managedAuthPath: this.assertManagedAuthPath(managedAuthPath, accountId),
      managedAuthRuntime: 'host',
      wslDistro: null,
      wslLinuxAuthPath: null
    }
  }

  private tryCreateWslManagedAuthDir(
    accountId: string,
    target?: ClaudeAccountAddTarget
  ): ManagedClaudeAuthLocation | null {
    if (process.platform !== 'win32' || target?.runtime !== 'wsl') {
      return null
    }

    const distroArgs = target.wslDistro?.trim() ? ['-d', target.wslDistro.trim()] : []
    const infoOutput = execFileSync(
      'wsl.exe',
      [...distroArgs, '--', 'bash', '-lc', 'printf "%s\\n%s\\n" "$WSL_DISTRO_NAME" "$HOME"'],
      { encoding: 'utf-8', timeout: 5000 }
    )
    const [rawDistro, rawHome] = infoOutput
      .replaceAll(String.fromCharCode(0), '')
      .split(/\r?\n/)
      .map((line) => line.trim())
    const distro = target.wslDistro?.trim() || rawDistro
    const home = rawHome
    if (!distro || !home?.startsWith('/')) {
      throw new Error('Could not resolve the active WSL home directory for Claude login.')
    }

    const wslLinuxAuthPath = `${home.replace(/\/$/, '')}/.local/share/orca/claude-accounts/${accountId}/auth`
    const markerPath = `${wslLinuxAuthPath}/.orca-managed-claude-auth`
    execFileSync(
      'wsl.exe',
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        `mkdir -p ${shellQuote(wslLinuxAuthPath)} && printf '%s\\n' ${shellQuote(accountId)} > ${shellQuote(markerPath)}`
      ],
      { encoding: 'utf-8', timeout: 5000 }
    )

    const managedAuthPath = toWindowsWslPath(wslLinuxAuthPath, distro)
    return {
      managedAuthPath: this.assertManagedAuthPath(managedAuthPath, accountId),
      managedAuthRuntime: 'wsl',
      wslDistro: distro,
      wslLinuxAuthPath
    }
  }

  private getManagedAccountsRoot(): string {
    const root = getClaudeManagedAccountsRoot()
    mkdirSync(root, { recursive: true })
    return root
  }

  private assertManagedAuthPath(candidatePath: string, expectedAccountId?: string): string {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      if (
        !wslInfo.linuxPath.includes('/.local/share/orca/claude-accounts/') ||
        !wslInfo.linuxPath.endsWith('/auth')
      ) {
        throw new Error('Managed WSL Claude auth storage is outside Orca account storage.')
      }
      if (process.platform === 'win32') {
        try {
          const canonicalLinuxPath = execFileSync(
            'wsl.exe',
            [
              '-d',
              wslInfo.distro,
              '--',
              'bash',
              '-lc',
              buildEncodedWslBashCommand(
                [
                  'set -euo pipefail',
                  `candidate=${shellQuote(wslInfo.linuxPath)}`,
                  'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
                  'candidate_real=$(readlink -f -- "$candidate")',
                  'managed_root_real=$(readlink -f -- "$managed_root")',
                  'test -f "$candidate_real/.orca-managed-claude-auth"',
                  expectedAccountId
                    ? `test "$(cat "$candidate_real/.orca-managed-claude-auth")" = ${shellQuote(expectedAccountId)}`
                    : 'test -n "$(cat "$candidate_real/.orca-managed-claude-auth")"',
                  'case "$candidate_real" in "$managed_root_real"/*/auth) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
                ].join('\n')
              )
            ],
            { encoding: 'utf-8', timeout: 5000 }
          ).trim()
          if (!canonicalLinuxPath) {
            throw new Error('Managed Claude auth directory does not exist on disk.')
          }
          return toWindowsWslPath(canonicalLinuxPath, wslInfo.distro)
        } catch (error) {
          throw new Error('Managed WSL Claude auth storage is outside Orca account storage.', {
            cause: error
          })
        }
      }
      if (
        !existsSync(candidatePath) ||
        !existsSync(join(candidatePath, '.orca-managed-claude-auth'))
      ) {
        throw new Error('Managed Claude auth storage is not owned by Orca.')
      }
      return candidatePath
    }

    this.getManagedAccountsRoot()
    const accountId = expectedAccountId ?? this.readManagedAuthAccountIdFromPath(candidatePath)
    if (!accountId || (expectedAccountId && accountId !== expectedAccountId)) {
      throw new Error('Managed Claude auth directory does not exist on disk.')
    }
    const trustedPath = resolveOwnedClaudeManagedAuthPath(accountId, candidatePath, {
      adoptLegacyMarker: true
    })
    if (!trustedPath) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    return trustedPath
  }

  private readManagedAuthAccountIdFromPath(candidatePath: string): string | null {
    const rootPath = this.getManagedAccountsRoot()
    const relativePath = relative(resolve(rootPath), resolve(candidatePath))
    const parts = relativePath.split(sep)
    return parts.length === 2 && parts[1] === 'auth' ? parts[0] : null
  }

  private async safeRemoveManagedAuth(accountId: string, candidatePath: string): Promise<void> {
    try {
      const managedAuthPath = this.assertManagedAuthPath(candidatePath, accountId)
      rmSync(resolve(managedAuthPath, '..'), { recursive: true, force: true })
    } catch (error) {
      console.warn('[claude-accounts] Refusing to remove untrusted managed auth:', error)
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
  }

  private runClaudeCommand(
    args: string[],
    configDir: { windowsPath: string; linuxPath: string | null; wslDistro: string | null },
    timeoutMs: number,
    options?: { allowFailure?: boolean }
  ): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const spawnConfig =
        configDir.linuxPath && configDir.wslDistro
          ? {
              command: 'wsl.exe',
              args: [
                '-d',
                configDir.wslDistro,
                '--',
                'bash',
                '-lc',
                `export CLAUDE_CONFIG_DIR=${shellQuote(configDir.linuxPath)}; exec claude ${args.map(shellQuote).join(' ')}`
              ],
              env: process.env,
              shell: false
            }
          : {
              command: resolveClaudeCommand(),
              args,
              env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: configDir.windowsPath
              },
              shell: process.platform === 'win32'
            }
      const child = spawn(spawnConfig.command, spawnConfig.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: spawnConfig.shell,
        env: spawnConfig.env
      })

      let settled = false
      let output = ''
      const appendOutput = (chunk: Buffer): void => {
        output = `${output}${chunk.toString()}`
        if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
          output = output.slice(-MAX_COMMAND_OUTPUT_CHARS)
        }
      }
      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        callback()
      }
      const timeout = setTimeout(() => {
        child.kill()
        settle(() => rejectPromise(new Error('Claude sign-in took too long to finish.')))
      }, timeoutMs)

      child.stdout.on('data', appendOutput)
      child.stderr.on('data', appendOutput)
      child.on('error', (error) => {
        settle(() => rejectPromise(error))
      })
      child.on('close', (code) => {
        settle(() => {
          if (code === 0 || options?.allowFailure) {
            resolvePromise(output)
            return
          }
          const trimmedOutput = output.trim()
          rejectPromise(
            new Error(
              trimmedOutput
                ? `Claude command failed: ${trimmedOutput}`
                : `Claude command exited with code ${code ?? 'unknown'}.`
            )
          )
        })
      })
    })
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value) as unknown
      return this.asRecord(parsed)
    } catch {
      return null
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    return value as Record<string, unknown>
  }

  private readString(value: Record<string, unknown> | null, key: string): string | null {
    const field = value?.[key]
    return typeof field === 'string' ? field : null
  }

  private normalizeField(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
}
