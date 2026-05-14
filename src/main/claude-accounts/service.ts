/* eslint-disable max-lines -- Why: Claude managed accounts need one audited owner
for login, credential capture, Keychain storage, selection, and rate-limit refresh. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type {
  ClaudeManagedAccount,
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../shared/types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeRuntimeAuthService } from './runtime-auth-service'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  deleteManagedClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'

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

  async addAccount(): Promise<ClaudeRateLimitAccountsState> {
    return this.serializeMutation(() => this.doAddAccount())
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

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  private async doAddAccount(): Promise<ClaudeRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedAuthPath = this.createManagedAuthDir(accountId)
    const previousSettings = this.store.getSettings()

    try {
      const captured = await this.runClaudeLoginAndCapture()
      if (!captured.identity.email) {
        throw new Error('Claude login completed, but Orca could not resolve the account email.')
      }
      await this.writeManagedAuth(accountId, managedAuthPath, captured)

      const now = Date.now()
      const account: ClaudeManagedAccount = {
        id: accountId,
        email: captured.identity.email,
        managedAuthPath,
        authMethod: 'subscription-oauth',
        organizationUuid: captured.identity.organizationUuid,
        organizationName: captured.identity.organizationName,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }

      const outgoingAccountId = previousSettings.activeClaudeManagedAccountId
      this.store.updateSettings({
        claudeManagedAccounts: [...previousSettings.claudeManagedAccounts, account],
        activeClaudeManagedAccountId: account.id
      })
      this.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
      await this.syncRuntimeAuthWithLivePtyGate()
      await this.rateLimits.refreshForClaudeAccountChange(outgoingAccountId)
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
    const managedAuthPath = this.assertManagedAuthPath(account.managedAuthPath)
    const previousSettings = this.store.getSettings()
    const captured = await this.runClaudeLoginAndCapture()
    if (!captured.identity.email) {
      throw new Error('Claude login completed, but Orca could not resolve the account email.')
    }
    await this.writeManagedAuth(accountId, managedAuthPath, captured)

    const settings = this.store.getSettings()
    const now = Date.now()
    this.store.updateSettings({
      claudeManagedAccounts: settings.claudeManagedAccounts.map((entry) =>
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
    })
    try {
      this.runtimeAuth.clearLastWrittenCredentialsJson(accountId)
      await this.syncRuntimeAuthWithLivePtyGate()
      await this.rateLimits.refreshForClaudeAccountChange()
      return this.getSnapshot()
    } catch (error) {
      this.restoreClaudeSettings(previousSettings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  private async doRemoveAccount(accountId: string): Promise<ClaudeRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.claudeManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextActiveId =
      settings.activeClaudeManagedAccountId === accountId
        ? null
        : settings.activeClaudeManagedAccountId

    this.store.updateSettings({
      claudeManagedAccounts: nextAccounts,
      activeClaudeManagedAccountId: nextActiveId
    })
    try {
      await this.syncRuntimeAuthWithLivePtyGate()
      await this.safeRemoveManagedAuth(accountId, account.managedAuthPath)
      this.rateLimits.evictInactiveClaudeCache(accountId)
      await this.rateLimits.refreshForClaudeAccountChange(
        settings.activeClaudeManagedAccountId === accountId
          ? settings.activeClaudeManagedAccountId
          : undefined
      )
      return this.getSnapshot()
    } catch (error) {
      this.restoreClaudeSettings(settings)
      await this.runtimeAuth.forceMaterializeCurrentSelectionForRollback()
      throw error
    }
  }

  private async doSelectAccount(accountId: string | null): Promise<ClaudeRateLimitAccountsState> {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }
    const previousSettings = this.store.getSettings()
    const outgoingAccountId = previousSettings.activeClaudeManagedAccountId
    this.store.updateSettings({ activeClaudeManagedAccountId: accountId })
    try {
      await this.syncRuntimeAuthWithLivePtyGate()
      await this.rateLimits.refreshForClaudeAccountChange(outgoingAccountId)
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
      activeAccountId: settings.activeClaudeManagedAccountId
    }
  }

  private toSummary(account: ClaudeManagedAccount): ClaudeManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
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
    if (!settings.activeClaudeManagedAccountId) {
      return
    }
    const hasActiveAccount = settings.claudeManagedAccounts.some(
      (entry) => entry.id === settings.activeClaudeManagedAccountId
    )
    if (!hasActiveAccount) {
      this.store.updateSettings({ activeClaudeManagedAccountId: null })
    }
  }

  private restoreClaudeSettings(settings: ReturnType<Store['getSettings']>): void {
    this.store.updateSettings({
      claudeManagedAccounts: settings.claudeManagedAccounts,
      activeClaudeManagedAccountId: settings.activeClaudeManagedAccountId
    })
  }

  private async syncRuntimeAuthWithLivePtyGate(operation?: () => Promise<void>): Promise<void> {
    beginClaudeAuthSwitch()
    try {
      await (operation ? operation() : this.runtimeAuth.syncForCurrentSelection())
    } finally {
      endClaudeAuthSwitch()
    }
  }

  private async runClaudeLoginAndCapture(): Promise<CapturedClaudeAuth> {
    const tempConfigDir = mkdtempSync(join(tmpdir(), 'orca-claude-login-'))
    const previousActiveKeychain = await readActiveClaudeKeychainCredentials()
    try {
      await this.runClaudeCommand(['auth', 'login', '--claudeai'], tempConfigDir, LOGIN_TIMEOUT_MS)
      const status = await this.runClaudeCommand(
        ['auth', 'status', '--json'],
        tempConfigDir,
        STATUS_TIMEOUT_MS,
        { allowFailure: true }
      )
      return await this.captureAuthFromConfigDir(tempConfigDir, status)
    } finally {
      if (process.platform === 'darwin' && previousActiveKeychain) {
        // Why: Claude login writes the global active Keychain item even when
        // CLAUDE_CONFIG_DIR points elsewhere. Restore it so adding an account
        // does not switch the user's external Claude CLI out from under them.
        await writeActiveClaudeKeychainCredentials(previousActiveKeychain)
      } else if (process.platform === 'darwin') {
        await deleteActiveClaudeKeychainCredentialsStrict()
      }
      rmSync(tempConfigDir, { recursive: true, force: true })
    }
  }

  private async captureAuthFromConfigDir(
    configDir: string,
    statusOutput: string
  ): Promise<CapturedClaudeAuth> {
    const credentialsJson = await this.readCapturedCredentials(configDir)
    if (!credentialsJson) {
      throw new Error('Claude login completed, but no OAuth credentials were captured.')
    }
    const oauthAccount = this.readOauthAccountFromConfigDir(configDir)
    const identity = this.resolveIdentity(statusOutput, oauthAccount, credentialsJson)
    return { credentialsJson, oauthAccount, identity }
  }

  private async readCapturedCredentials(configDir: string): Promise<string | null> {
    if (process.platform === 'darwin') {
      return readActiveClaudeKeychainCredentials()
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
    const trustedPath = this.assertManagedAuthPath(managedAuthPath)
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(accountId, captured.credentialsJson)
    } else {
      writeFileAtomically(join(trustedPath, '.credentials.json'), captured.credentialsJson, {
        mode: 0o600
      })
    }
    writeFileAtomically(
      join(trustedPath, 'oauth-account.json'),
      `${JSON.stringify(captured.oauthAccount, null, 2)}\n`,
      { mode: 0o600 }
    )
  }

  private createManagedAuthDir(accountId: string): string {
    const managedAuthPath = join(this.getManagedAccountsRoot(), accountId, 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), `${accountId}\n`, 'utf-8')
    return this.assertManagedAuthPath(managedAuthPath)
  }

  private getManagedAccountsRoot(): string {
    const root = join(app.getPath('userData'), 'claude-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  private assertManagedAuthPath(candidatePath: string): string {
    const rootPath = this.getManagedAccountsRoot()
    const resolvedCandidate = resolve(candidatePath)
    const resolvedRoot = resolve(rootPath)
    if (!existsSync(resolvedCandidate)) {
      throw new Error('Managed Claude auth directory does not exist on disk.')
    }
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(resolvedRoot)
    if (
      canonicalCandidate !== canonicalRoot &&
      !canonicalCandidate.startsWith(canonicalRoot + sep)
    ) {
      throw new Error(
        `Managed Claude auth is outside current storage root (expected under ${canonicalRoot}).`
      )
    }
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const escaped =
      relativePath === '' || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)
    if (escaped || !existsSync(join(canonicalCandidate, '.orca-managed-claude-auth'))) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    return canonicalCandidate
  }

  private async safeRemoveManagedAuth(accountId: string, candidatePath: string): Promise<void> {
    try {
      const managedAuthPath = this.assertManagedAuthPath(candidatePath)
      rmSync(resolve(managedAuthPath, '..'), { recursive: true, force: true })
    } catch (error) {
      console.warn('[claude-accounts] Refusing to remove untrusted managed auth:', error)
    }
    await deleteManagedClaudeKeychainCredentials(accountId)
  }

  private runClaudeCommand(
    args: string[],
    configDir: string,
    timeoutMs: number,
    options?: { allowFailure?: boolean }
  ): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const claudeCommand = resolveClaudeCommand()
      const child = spawn(claudeCommand, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir
        }
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
