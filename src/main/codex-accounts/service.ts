/* eslint-disable max-lines -- Why: this service intentionally keeps Codex
account lifecycle, path safety, login, and identity parsing in one audited
main-process module so the managed-account boundary stays explicit. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { getSpawnArgsForWindows } from '../win32-utils'
import type {
  CodexManagedAccount,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../../shared/types'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import { writeFileAtomically } from './fs-utils'
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
  // Why: account mutations read settings, do async work (login, rate-limit
  // refresh), then write settings. Without serialization, overlapping calls
  // (e.g. double-click "Add Account") can cause lost updates.
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: Store,
    private readonly rateLimits: RateLimitService,
    private readonly runtimeHome: CodexRuntimeHomeService
  ) {
    this.safeSyncCanonicalConfigToManagedHomes()
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  listAccounts(): CodexRateLimitAccountsState {
    this.normalizeActiveSelection()
    return this.getSnapshot()
  }

  async addAccount(): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doAddAccount())
  }

  async reauthenticateAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doReauthenticateAccount(accountId))
  }

  async removeAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doRemoveAccount(accountId))
  }

  async selectAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doSelectAccount(accountId))
  }

  private async doAddAccount(): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHomePath = this.createManagedHome(accountId)

    try {
      this.safeSyncCanonicalConfigIntoManagedHome(managedHomePath)
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
      this.safeSyncCanonicalConfigToManagedHomes()
      this.runtimeHome.clearLastWrittenAuthJson(account.id)
      this.runtimeHome.syncForCurrentSelection()

      // Why: the new account becomes active, so the previous active account is
      // now inactive and its last-known usage should be cached for the switcher.
      const outgoingAccountId = settings.activeCodexManagedAccountId
      await this.rateLimits.refreshForCodexAccountChange(outgoingAccountId)
      return this.getSnapshot()
    } catch (error) {
      this.safeRemoveManagedHome(managedHomePath)
      throw error
    }
  }

  private async doReauthenticateAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
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
    this.safeSyncCanonicalConfigToManagedHomes()
    this.runtimeHome.clearLastWrittenAuthJson(accountId)
    this.runtimeHome.syncForCurrentSelection()

    // Why: re-auth can change which actual Codex identity the managed home
    // points at. Force a fresh read immediately so the status bar cannot keep
    // showing the previous account's quota under the updated label.
    await this.rateLimits.refreshForCodexAccountChange()
    return this.getSnapshot()
  }

  private async doRemoveAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
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
    this.runtimeHome.syncForCurrentSelection()

    this.safeRemoveManagedHome(account.managedHomePath)
    // Why: a removed account can no longer appear in the switcher dropdown,
    // so purge its cached usage to avoid stale entries.
    this.rateLimits.evictInactiveCodexCache(accountId)
    await this.rateLimits.refreshForCodexAccountChange(
      settings.activeCodexManagedAccountId === accountId
        ? settings.activeCodexManagedAccountId
        : undefined
    )
    return this.getSnapshot()
  }

  private async doSelectAccount(accountId: string | null): Promise<CodexRateLimitAccountsState> {
    if (accountId !== null) {
      this.requireAccount(accountId)
    }

    const previousSettings = this.store.getSettings()
    const outgoingAccountId = previousSettings.activeCodexManagedAccountId

    this.store.updateSettings({
      activeCodexManagedAccountId: accountId
    })
    this.safeSyncCanonicalConfigToManagedHomes()
    this.runtimeHome.syncForCurrentSelection()

    await this.rateLimits.refreshForCodexAccountChange(outgoingAccountId)
    return this.getSnapshot()
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

  private safeSyncCanonicalConfigToManagedHomes(): void {
    try {
      this.syncCanonicalConfigToManagedHomes()
    } catch (error) {
      console.warn('[codex-accounts] Failed to sync canonical config:', error)
    }
  }

  private safeSyncCanonicalConfigIntoManagedHome(managedHomePath: string): void {
    try {
      this.syncCanonicalConfigIntoManagedHome(managedHomePath)
    } catch (error) {
      console.warn('[codex-accounts] Failed to seed managed config:', error)
    }
  }

  private syncCanonicalConfigToManagedHomes(): void {
    const canonicalConfig = this.readCanonicalConfig()
    if (canonicalConfig === null) {
      return
    }

    const settings = this.store.getSettings()
    for (const account of settings.codexManagedAccounts) {
      try {
        this.syncCanonicalConfigIntoManagedHome(account.managedHomePath, canonicalConfig)
      } catch (error) {
        console.warn('[codex-accounts] Failed to sync managed config:', error)
      }
    }
  }

  private syncCanonicalConfigIntoManagedHome(
    managedHomePath: string,
    canonicalConfig = this.readCanonicalConfig()
  ): void {
    if (canonicalConfig === null) {
      return
    }

    const trustedManagedHomePath = this.assertManagedHomePath(managedHomePath)
    // Why: Orca account switching is meant to swap Codex credentials and quota
    // identity, not silently fork the user's sandbox/config defaults. Syncing
    // one canonical config into every managed home keeps auth isolated per
    // account while preserving consistent Codex behavior.
    this.writeManagedConfig(trustedManagedHomePath, canonicalConfig)
  }

  private readCanonicalConfig(): string | null {
    const primaryConfigPath = join(homedir(), '.codex', 'config.toml')
    if (!existsSync(primaryConfigPath)) {
      return null
    }

    try {
      return readFileSync(primaryConfigPath, 'utf-8')
    } catch (error) {
      console.warn('[codex-accounts] Failed to read canonical config:', error)
      return null
    }
  }

  private writeManagedConfig(managedHomePath: string, contents: string): void {
    writeFileAtomically(join(managedHomePath, 'config.toml'), contents)
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

    if (!existsSync(resolvedCandidate)) {
      throw new Error('Managed Codex home directory does not exist on disk.')
    }

    // realpath() requires the leaf to exist. For pre-login add flow we create
    // the home directory first so the containment check still verifies the
    // canonical on-disk target rather than trusting persisted text blindly.
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(resolvedRoot)

    // Why: the prefix check must compare canonical paths on both sides. On
    // macOS, userData sits under /var/folders/... which realpath resolves to
    // /private/var/folders/...; comparing a canonical candidate against a
    // non-canonical root would spuriously reject every managed home. In dev
    // mode (orca-dev/ vs orca/) this check also filters out production-rooted
    // paths before downstream sync runs.
    if (
      canonicalCandidate !== canonicalRoot &&
      !canonicalCandidate.startsWith(canonicalRoot + sep)
    ) {
      throw new Error(
        `Managed Codex home is outside current storage root (expected under ${canonicalRoot}).`
      )
    }
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const escaped =
      relativePath === '' || relativePath.startsWith('..') || relativePath.includes(`..${sep}`)

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

    // Why: managed homes live at <accounts-root>/<uuid>/home. Removing
    // just the home/ leaf leaves an empty <uuid>/ directory behind.
    try {
      const parentDir = resolve(managedHomePath, '..')
      // Why: managedHomePath is already canonicalized by assertManagedHomePath,
      // so the root must be canonicalized too for the prefix check to work on
      // macOS where userData resolves through /private/var.
      const root = realpathSync(this.getManagedAccountsRoot())
      if (parentDir.startsWith(root + sep) && parentDir !== root) {
        rmSync(parentDir, { recursive: true, force: true })
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async runCodexLogin(managedHomePath: string): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const codexCommand = resolveCodexCommand()
      // Why: on Windows, resolveCodexCommand() may return a .cmd/.bat file
      // (e.g. codex.cmd from npm). Node's child_process.spawn cannot execute
      // batch scripts directly without shell:true, but shell:true with an args
      // array causes DEP0190 because args are concatenated, not escaped.
      // Fix: detect batch scripts and invoke cmd.exe /c explicitly.
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(codexCommand, ['login'])
      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Why: route through cmd.exe for .cmd/.bat entrypoints would otherwise
        // flash a console window in the packaged GUI app on Windows.
        windowsHide: true,
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
          const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
          // Why: ENOENT can mean either the codex binary doesn't exist OR the
          // script's shebang interpreter (node) isn't in PATH. When we resolved
          // codex to a full path, ENOENT almost certainly means node is missing.
          const isBareCommand = codexCommand === 'codex'
          const message = isEnoent
            ? isBareCommand
              ? 'Codex CLI not found.'
              : 'Codex CLI found but could not run — Node.js may not be in your PATH.'
            : error.message
          rejectPromise(new Error(message))
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

    // Why: API-key-based auth files have no OAuth tokens or JWT identity
    // claims. Returning nulls causes the caller to fail with a clear
    // "could not resolve the account email" error rather than crashing
    // on missing nested token fields.
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
