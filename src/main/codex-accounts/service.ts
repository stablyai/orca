/* eslint-disable max-lines -- Why: this service intentionally keeps Codex
account lifecycle, path safety, login, and identity parsing in one audited
main-process module so the managed-account boundary stays explicit. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type {
  CodexManagedAccount,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../../shared/types'
import { resolveCodexCommand } from '../codex-cli/command'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'

const LOGIN_TIMEOUT_MS = 120_000
const MAX_LOGIN_OUTPUT_CHARS = 4_000

type CodexOAuthCredentials = {
  idToken: string | null
  accountId: string | null
}

type ResolvedCodexIdentity = {
  email: string | null
  providerAccountId: string | null
  workspaceLabel: string | null
  workspaceAccountId: string | null
}

export class CodexAccountService {
  constructor(
    private readonly store: Store,
    private readonly rateLimits: RateLimitService
  ) {}

  listAccounts(): CodexRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  async addAccount(): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHomePath = this.createManagedHome(accountId)

    try {
      await this.runCodexLogin(managedHomePath)
      const identity = this.readIdentityFromHome(managedHomePath)
      if (!identity.email) {
        throw new Error('Codex login completed, but Orca could not resolve the account email.')
      }

      const now = Date.now()
      const account: CodexManagedAccount = {
        id: accountId,
        email: identity.email,
        managedHomePath,
        providerAccountId: identity.providerAccountId,
        workspaceLabel: identity.workspaceLabel,
        workspaceAccountId: identity.workspaceAccountId,
        createdAt: now,
        updatedAt: now,
        lastAuthenticatedAt: now
      }

      const settings = this.store.getSettings()
      this.store.updateSettings({
        codexManagedAccounts: [...settings.codexManagedAccounts, account],
        activeCodexManagedAccountId: account.id
      })

      await this.rateLimits.refreshForCodexAccountChange()
      return this.getSnapshot()
    } catch (error) {
      this.safeRemoveManagedHome(managedHomePath)
      throw error
    }
  }

  async reauthenticateAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const managedHomePath = this.assertManagedHomePath(account.managedHomePath)

    await this.runCodexLogin(managedHomePath)
    const identity = this.readIdentityFromHome(managedHomePath)
    if (!identity.email) {
      throw new Error('Codex login completed, but Orca could not resolve the account email.')
    }

    const settings = this.store.getSettings()
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

    this.store.updateSettings({
      codexManagedAccounts: updatedAccounts
    })

    // Why: re-auth can change which actual Codex identity the managed home
    // points at. Force a fresh read immediately so the status bar cannot keep
    // showing the previous account's quota under the updated label.
    await this.rateLimits.refreshForCodexAccountChange()
    return this.getSnapshot()
  }

  async removeAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.codexManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextActiveId =
      settings.activeCodexManagedAccountId === accountId
        ? null
        : settings.activeCodexManagedAccountId

    this.store.updateSettings({
      codexManagedAccounts: nextAccounts,
      activeCodexManagedAccountId: nextActiveId
    })

    this.safeRemoveManagedHome(account.managedHomePath)
    await this.rateLimits.refreshForCodexAccountChange()
    return this.getSnapshot()
  }

  async selectAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }

    this.store.updateSettings({
      activeCodexManagedAccountId: accountId
    })

    await this.rateLimits.refreshForCodexAccountChange()
    return this.getSnapshot()
  }

  getSelectedManagedHomePath(): string | null {
    const account = this.getActiveAccount()
    if (!account) {
      return null
    }

    try {
      return this.assertManagedHomePath(account.managedHomePath)
    } catch (error) {
      // Why: if the selected managed home was deleted or tampered with outside
      // Orca, the safest recovery is to fall back to the ambient system Codex
      // login immediately rather than keeping a broken active selection around.
      this.store.updateSettings({ activeCodexManagedAccountId: null })
      console.warn('[codex-accounts] Ignoring invalid managed home path:', error)
      return null
    }
  }

  private getSnapshot(): CodexRateLimitAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.codexManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: settings.activeCodexManagedAccountId
    }
  }

  private getActiveAccount(): CodexManagedAccount | null {
    this.normalizeActiveSelection()
    const settings = this.store.getSettings()
    if (!settings.activeCodexManagedAccountId) {
      return null
    }
    return (
      settings.codexManagedAccounts.find(
        (entry) => entry.id === settings.activeCodexManagedAccountId
      ) ?? null
    )
  }

  private toSummary(account: CodexManagedAccount): CodexManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
      providerAccountId: account.providerAccountId ?? null,
      workspaceLabel: account.workspaceLabel ?? null,
      workspaceAccountId: account.workspaceAccountId ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt
    }
  }

  private requireAccount(accountId: string): CodexManagedAccount {
    const settings = this.store.getSettings()
    const account = settings.codexManagedAccounts.find((entry) => entry.id === accountId)
    if (!account) {
      throw new Error('That Codex rate limit account no longer exists.')
    }
    return account
  }

  private normalizeActiveSelection(): void {
    const settings = this.store.getSettings()
    if (!settings.activeCodexManagedAccountId) {
      return
    }
    const hasActiveAccount = settings.codexManagedAccounts.some(
      (entry) => entry.id === settings.activeCodexManagedAccountId
    )
    if (!hasActiveAccount) {
      this.store.updateSettings({ activeCodexManagedAccountId: null })
    }
  }

  private createManagedHome(accountId: string): string {
    const managedHomePath = join(this.getManagedAccountsRoot(), accountId, 'home')
    mkdirSync(managedHomePath, { recursive: true })
    // Why: Codex expects CODEX_HOME to be a concrete directory it can own. We
    // pre-create the directory and leave a marker so future cleanup code can
    // prove the path belongs to Orca before deleting anything.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
    return this.assertManagedHomePath(managedHomePath)
  }

  private getManagedAccountsRoot(): string {
    const root = join(app.getPath('userData'), 'codex-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  private assertManagedHomePath(candidatePath: string): string {
    const rootPath = this.getManagedAccountsRoot()
    const resolvedCandidate = resolve(candidatePath)
    const resolvedRoot = resolve(rootPath)

    // realpath() requires the leaf to exist. For pre-login add flow we create
    // the home directory first so the containment check still verifies the
    // canonical on-disk target rather than trusting persisted text blindly.
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(resolvedRoot)
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const escaped =
      relativePath === '' ||
      relativePath === '.' ||
      relativePath.startsWith('..') ||
      relativePath.includes(`..${sep}`)

    if (escaped) {
      throw new Error('Managed Codex home escaped Orca account storage.')
    }

    if (!existsSync(join(canonicalCandidate, '.orca-managed-home'))) {
      throw new Error('Managed Codex home is missing Orca ownership marker.')
    }

    return canonicalCandidate
  }

  private safeRemoveManagedHome(candidatePath: string): void {
    let managedHomePath: string
    try {
      managedHomePath = this.assertManagedHomePath(candidatePath)
    } catch (error) {
      console.warn('[codex-accounts] Refusing to remove untrusted managed home:', error)
      return
    }

    rmSync(managedHomePath, { recursive: true, force: true })
  }

  private async runCodexLogin(managedHomePath: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(resolveCodexCommand(), ['login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: managedHomePath
        }
      })

      let settled = false
      let output = ''
      const appendOutput = (chunk: Buffer): void => {
        output = `${output}${chunk.toString()}`
        if (output.length > MAX_LOGIN_OUTPUT_CHARS) {
          output = output.slice(-MAX_LOGIN_OUTPUT_CHARS)
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
        settle(() => {
          rejectPromise(new Error('Codex sign-in took too long to finish. Please try again.'))
        })
      }, LOGIN_TIMEOUT_MS)

      child.stdout.on('data', appendOutput)
      child.stderr.on('data', appendOutput)

      child.on('error', (error) => {
        settle(() => {
          const cause = (error as NodeJS.ErrnoException).code === 'ENOENT'
          rejectPromise(new Error(cause ? 'Codex CLI not found.' : error.message))
        })
      })

      child.on('close', (code) => {
        settle(() => {
          if (code === 0) {
            resolvePromise()
            return
          }
          const trimmedOutput = output.trim()
          rejectPromise(
            new Error(
              trimmedOutput
                ? `Codex login failed: ${trimmedOutput}`
                : `Codex login exited with code ${code ?? 'unknown'}.`
            )
          )
        })
      })
    })
  }

  private readIdentityFromHome(managedHomePath: string): ResolvedCodexIdentity {
    const credentials = this.loadOAuthCredentials(managedHomePath)
    const payload = credentials.idToken ? this.parseJwtPayload(credentials.idToken) : null
    const authClaims = this.readRecordClaim(payload, 'https://api.openai.com/auth')
    const profileClaims = this.readRecordClaim(payload, 'https://api.openai.com/profile')

    return {
      email: this.normalizeField(
        this.readStringClaim(payload, 'email') ?? this.readStringClaim(profileClaims, 'email')
      ),
      providerAccountId: this.normalizeField(
        credentials.accountId ??
          this.readStringClaim(authClaims, 'chatgpt_account_id') ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      ),
      workspaceLabel: this.normalizeField(
        this.readStringClaim(authClaims, 'workspace_name') ??
          this.readStringClaim(profileClaims, 'workspace_name')
      ),
      workspaceAccountId: this.normalizeField(
        this.readStringClaim(authClaims, 'workspace_account_id') ??
          credentials.accountId ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      )
    }
  }

  private loadOAuthCredentials(managedHomePath: string): CodexOAuthCredentials {
    const authFilePath = join(this.assertManagedHomePath(managedHomePath), 'auth.json')
    const raw = JSON.parse(readFileSync(authFilePath, 'utf-8')) as Record<string, unknown>

    if (typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim() !== '') {
      return {
        idToken: null,
        accountId: null
      }
    }

    const tokens = this.readRecordClaim(raw, 'tokens')
    return {
      idToken: this.normalizeField(
        this.readStringClaim(tokens, 'id_token') ?? this.readStringClaim(tokens, 'idToken')
      ),
      accountId: this.normalizeField(
        this.readStringClaim(tokens, 'account_id') ?? this.readStringClaim(tokens, 'accountId')
      )
    }
  }

  private parseJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.')
    if (parts.length < 2) {
      return null
    }

    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (payload.length % 4 !== 0) {
      payload += '='
    }

    try {
      const json = Buffer.from(payload, 'base64').toString('utf-8')
      return JSON.parse(json) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private readRecordClaim(
    value: Record<string, unknown> | null,
    key: string
  ): Record<string, unknown> | null {
    const claim = value?.[key]
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      return null
    }
    return claim as Record<string, unknown>
  }

  private readStringClaim(value: Record<string, unknown> | null, key: string): string | null {
    const claim = value?.[key]
    return typeof claim === 'string' ? claim : null
  }

  private normalizeField(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
}
