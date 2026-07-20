/* eslint-disable max-lines -- Why: keeps Codex account lifecycle, path safety, login, and identity parsing in one audited main-process module. */
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
import { rewriteRelativePathConfigValues } from '../codex/codex-config-path-reference-rewrite'
import { resolveCodexCommand } from '../codex-cli/command'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toWindowsWslPath } from '../wsl'
import { buildEncodedWslBashCommand } from '../wsl-bash-command'
import {
  buildWslCodexAvailabilityArgs,
  buildWslCodexLoginArgs,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from './wsl-codex-command'
import {
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexAccountSelectionTarget,
  normalizeCodexRuntimeSelection,
  pruneInvalidCodexRuntimeSelection,
  removeCodexAccountIdFromSelection,
  setSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'

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

type CanonicalCodexConfig = {
  contents: string
  /** Home the config was read from, in the path style Codex sees (Linux-side for WSL); relative settings resolve against it. */
  sourceHomePath: string
}

export type CodexAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

type ManagedHomeLocation = {
  managedHomePath: string
  managedHomeRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxHomePath: string | null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class CodexAccountService {
  // Why: serialize the read-modify-write of settings; overlapping calls (e.g. double-click Add) would lose updates.
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

  async addAccount(target?: CodexAccountAddTarget): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doAddAccount(target))
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

  async selectAccountForTarget(
    accountId: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    return this.serializeMutation(() => this.doSelectAccount(accountId, target))
  }

  private async doAddAccount(target?: CodexAccountAddTarget): Promise<CodexRateLimitAccountsState> {
    const accountId = randomUUID()
    const managedHome = this.createManagedHome(accountId, target)
    const { managedHomePath } = managedHome

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

      const settings = this.store.getSettings()
      const selection = normalizeCodexRuntimeSelection(settings)
      const targetSelection = getCodexSelectionTargetForAccount(account)
      this.store.updateSettings({
        codexManagedAccounts: [...settings.codexManagedAccounts, account],
        activeCodexManagedAccountId:
          targetSelection.runtime === 'host' ? account.id : selection.host,
        activeCodexManagedAccountIdsByRuntime: setSelectedCodexAccountIdForTarget(
          selection,
          account.id,
          targetSelection
        )
      })
      this.safeSyncCanonicalConfigToManagedHomes()
      this.runtimeHome.clearLastWrittenAuthJson(account.id)
      this.runtimeHome.syncForCurrentSelection()

      // Why: switching activates the new account, so cache the outgoing account's usage for the switcher.
      const outgoingAccountId = getSelectedCodexAccountIdForTarget(settings, targetSelection)
      await this.rateLimits.refreshForCodexAccountChange(outgoingAccountId, targetSelection)
      return this.getSnapshot()
    } catch (error) {
      this.safeRemoveManagedHome(managedHomePath)
      throw error
    }
  }

  private async doReauthenticateAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const managedHomePath = this.ensureManagedHomeForReauthentication(account)

    this.safeSyncCanonicalConfigIntoManagedHome(managedHomePath)
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
    this.runtimeHome.syncForCurrentSelection(getCodexSelectionTargetForAccount(account))

    // Why: re-auth can change the underlying Codex identity, so force a fresh read to avoid showing stale quota.
    await this.rateLimits.refreshForCodexAccountChange(
      undefined,
      getCodexSelectionTargetForAccount(account)
    )
    return this.getSnapshot()
  }

  private async doRemoveAccount(accountId: string): Promise<CodexRateLimitAccountsState> {
    const account = this.requireAccount(accountId)
    const settings = this.store.getSettings()
    const nextAccounts = settings.codexManagedAccounts.filter((entry) => entry.id !== accountId)
    const nextSelection = removeCodexAccountIdFromSelection(
      normalizeCodexRuntimeSelection(settings),
      accountId
    )
    const nextActiveId =
      settings.activeCodexManagedAccountId === accountId ? null : nextSelection.host

    this.store.updateSettings({
      codexManagedAccounts: nextAccounts,
      activeCodexManagedAccountId: nextActiveId,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    })
    this.runtimeHome.syncForCurrentSelection()

    this.safeRemoveManagedHome(account.managedHomePath)
    // Why: removed accounts can't appear in the switcher, so purge cached usage to avoid stale entries.
    this.rateLimits.evictInactiveCodexCache(accountId)
    await this.rateLimits.refreshForCodexAccountChange(
      getSelectedCodexAccountIdForTarget(settings, getCodexSelectionTargetForAccount(account)) ===
        accountId
        ? accountId
        : undefined,
      getCodexSelectionTargetForAccount(account)
    )
    return this.getSnapshot()
  }

  private async doSelectAccount(
    accountId: string | null,
    target?: CodexAccountSelectionTarget
  ): Promise<CodexRateLimitAccountsState> {
    let effectiveTarget = target
    if (accountId !== null) {
      const account = this.requireAccount(accountId)
      const accountTarget = getCodexSelectionTargetForAccount(account)
      const requestedTarget = normalizeCodexAccountSelectionTarget(target ?? accountTarget)
      const normalizedAccountTarget = normalizeCodexAccountSelectionTarget(accountTarget)
      if (
        requestedTarget.runtime !== normalizedAccountTarget.runtime ||
        (requestedTarget.wslDistro !== null &&
          requestedTarget.wslDistro !== normalizedAccountTarget.wslDistro)
      ) {
        throw new Error('That Codex account belongs to a different runtime.')
      }
      effectiveTarget = accountTarget
    }

    const previousSettings = this.store.getSettings()
    const selection = normalizeCodexRuntimeSelection(previousSettings)
    const outgoingAccountId = getSelectedCodexAccountIdForTarget(previousSettings, effectiveTarget)
    const nextSelection = setSelectedCodexAccountIdForTarget(selection, accountId, effectiveTarget)

    this.store.updateSettings({
      activeCodexManagedAccountId:
        effectiveTarget?.runtime === 'wsl' ? nextSelection.host : accountId,
      activeCodexManagedAccountIdsByRuntime: nextSelection
    })
    this.safeSyncCanonicalConfigToManagedHomes()
    this.runtimeHome.syncForCurrentSelection(effectiveTarget)

    await this.rateLimits.refreshForCodexAccountChange(outgoingAccountId, effectiveTarget)
    return this.getSnapshot()
  }

  private getSnapshot(): CodexRateLimitAccountsState {
    const settings = this.store.getSettings()
    return {
      accounts: settings.codexManagedAccounts
        .map((account) => this.toSummary(account))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeAccountId: normalizeCodexRuntimeSelection(settings).host,
      activeAccountIdsByRuntime: normalizeCodexRuntimeSelection(settings)
    }
  }

  private toSummary(account: CodexManagedAccount): CodexManagedAccountSummary {
    return {
      id: account.id,
      email: account.email,
      managedHomeRuntime: account.managedHomeRuntime ?? 'host',
      wslDistro: account.wslDistro ?? null,
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
    const selection = normalizeCodexRuntimeSelection(settings)
    const nextSelection = pruneInvalidCodexRuntimeSelection(
      selection,
      settings.codexManagedAccounts
    )
    const changed =
      nextSelection.host !== selection.host ||
      JSON.stringify(nextSelection.wsl) !== JSON.stringify(selection.wsl)
    if (changed) {
      this.store.updateSettings({
        activeCodexManagedAccountId: nextSelection.host,
        activeCodexManagedAccountIdsByRuntime: nextSelection
      })
    }
  }

  private createManagedHome(
    accountId: string,
    target?: CodexAccountAddTarget
  ): ManagedHomeLocation {
    const wslHome = this.tryCreateWslManagedHome(accountId, target)
    if (wslHome) {
      return wslHome
    }

    const managedHomePath = join(this.getManagedAccountsRoot(), accountId, 'home')
    mkdirSync(managedHomePath, { recursive: true })
    // Why: marker lets future cleanup prove the path belongs to Orca before deleting anything.
    writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
    return {
      managedHomePath: this.assertManagedHomePath(managedHomePath),
      managedHomeRuntime: 'host',
      wslDistro: null,
      wslLinuxHomePath: null
    }
  }

  private tryCreateWslManagedHome(
    accountId: string,
    target?: CodexAccountAddTarget
  ): ManagedHomeLocation | null {
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
      throw new Error('Could not resolve the active WSL home directory for Codex login.')
    }

    const wslLinuxHomePath = `${home.replace(/\/$/, '')}/.local/share/orca/codex-accounts/${accountId}/home`
    const markerPath = `${wslLinuxHomePath}/.orca-managed-home`
    execFileSync(
      'wsl.exe',
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        `mkdir -p ${shellQuote(wslLinuxHomePath)} && printf '%s\\n' ${shellQuote(accountId)} > ${shellQuote(markerPath)}`
      ],
      { encoding: 'utf-8', timeout: 5000 }
    )

    const managedHomePath = toWindowsWslPath(wslLinuxHomePath, distro)
    let trustedManagedHomePath: string
    try {
      trustedManagedHomePath = this.assertManagedHomePath(managedHomePath)
    } catch (error) {
      this.safeRemoveWslManagedHomeCandidate(distro, wslLinuxHomePath, accountId)
      throw error
    }

    return {
      managedHomePath: trustedManagedHomePath,
      managedHomeRuntime: 'wsl',
      wslDistro: distro,
      wslLinuxHomePath
    }
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
    const settings = this.store.getSettings()
    for (const account of settings.codexManagedAccounts) {
      try {
        this.syncCanonicalConfigIntoManagedHome(account.managedHomePath)
      } catch (error) {
        console.warn('[codex-accounts] Failed to sync managed config:', error)
      }
    }
  }

  private syncCanonicalConfigIntoManagedHome(
    managedHomePath: string,
    canonicalConfig = this.readCanonicalConfigForManagedHome(managedHomePath)
  ): void {
    if (canonicalConfig === null) {
      return
    }

    const trustedManagedHomePath = this.assertManagedHomePath(managedHomePath)
    // Why: sync one canonical config per home so switching swaps only auth/quota; rewrite relative paths to resolve against the source home.
    this.writeManagedConfig(
      trustedManagedHomePath,
      rewriteRelativePathConfigValues(canonicalConfig.contents, canonicalConfig.sourceHomePath)
    )
  }

  private readCanonicalConfig(): CanonicalCodexConfig | null {
    const sourceHomePath = join(homedir(), '.codex')
    const primaryConfigPath = join(sourceHomePath, 'config.toml')
    if (!existsSync(primaryConfigPath)) {
      return null
    }

    try {
      return { contents: readFileSync(primaryConfigPath, 'utf-8'), sourceHomePath }
    } catch (error) {
      console.warn('[codex-accounts] Failed to read canonical config:', error)
      return null
    }
  }

  private readCanonicalConfigForManagedHome(managedHomePath: string): CanonicalCodexConfig | null {
    const wslInfo = parseWslUncPath(managedHomePath)
    if (!wslInfo) {
      return this.readCanonicalConfig()
    }

    const managedRootMarker = '/.local/share/orca/codex-accounts/'
    const markerIndex = wslInfo.linuxPath.indexOf(managedRootMarker)
    if (markerIndex < 0) {
      return null
    }
    const wslHome = wslInfo.linuxPath.slice(0, markerIndex)
    const configPath = toWindowsWslPath(`${wslHome}/.codex/config.toml`, wslInfo.distro)
    if (!existsSync(configPath)) {
      return null
    }

    try {
      // Why: read over UNC but consumed inside WSL, so path rewrites must anchor to the Linux-side ~/.codex, not the UNC path.
      return { contents: readFileSync(configPath, 'utf-8'), sourceHomePath: `${wslHome}/.codex` }
    } catch (error) {
      console.warn('[codex-accounts] Failed to read WSL canonical config:', error)
      return null
    }
  }

  private writeManagedConfig(managedHomePath: string, contents: string): void {
    const configPath = join(managedHomePath, 'config.toml')
    try {
      if (existsSync(configPath) && readFileSync(configPath, 'utf-8') === contents) {
        return
      }
    } catch {
      // Why: a read error must not make a stale config look current; atomic write owns ACL repair and error surfacing.
    }
    writeFileAtomically(configPath, contents)
  }

  private getManagedAccountsRoot(): string {
    const root = join(app.getPath('userData'), 'codex-accounts')
    mkdirSync(root, { recursive: true })
    return root
  }

  private ensureManagedHomeForReauthentication(account: CodexManagedAccount): string {
    const wslInfo = parseWslUncPath(account.managedHomePath)
    if (wslInfo && process.platform === 'win32') {
      this.ensureExpectedWslManagedHomeForReauthentication(account, wslInfo)
      return this.assertManagedHomePath(account.managedHomePath)
    }

    try {
      return this.assertManagedHomePath(account.managedHomePath)
    } catch (error) {
      if (!this.isMissingManagedHomeError(error)) {
        throw error
      }
      return this.recreateExpectedHostManagedHomeForReauthentication(account, error)
    }
  }

  private recreateExpectedHostManagedHomeForReauthentication(
    account: CodexManagedAccount,
    originalError: unknown
  ): string {
    const expectedManagedHomePath = join(this.getManagedAccountsRoot(), account.id, 'home')
    if (!this.pathsEqual(account.managedHomePath, expectedManagedHomePath)) {
      throw originalError
    }

    // Why: re-auth may recreate a lost empty home, but only at the exact Orca-owned path persisted for this account.
    mkdirSync(expectedManagedHomePath, { recursive: true })
    writeFileSync(join(expectedManagedHomePath, '.orca-managed-home'), `${account.id}\n`, 'utf-8')
    return this.assertManagedHomePath(expectedManagedHomePath)
  }

  private ensureExpectedWslManagedHomeForReauthentication(
    account: CodexManagedAccount,
    wslInfo: { distro: string; linuxPath: string }
  ): void {
    if (
      account.managedHomeRuntime !== 'wsl' ||
      account.wslDistro !== wslInfo.distro ||
      account.wslLinuxHomePath !== wslInfo.linuxPath ||
      !wslInfo.linuxPath.endsWith(`/.local/share/orca/codex-accounts/${account.id}/home`)
    ) {
      return
    }

    execFileSync(
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
            `expected_marker=${shellQuote(account.id)}`,
            'marker="$candidate/.orca-managed-home"',
            'if [ -e "$candidate" ] && [ ! -f "$marker" ]; then exit 41; fi',
            'if [ -f "$marker" ] && [ "$(cat "$marker")" != "$expected_marker" ]; then exit 42; fi',
            'mkdir -p -- "$candidate"',
            'printf "%s\\n" "$expected_marker" > "$marker"'
          ].join('\n')
        )
      ],
      { encoding: 'utf-8', timeout: 5000 }
    )
  }

  private isMissingManagedHomeError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message === 'Managed Codex home directory does not exist on disk.'
    )
  }

  private pathsEqual(left: string, right: string): boolean {
    const resolvedLeft = resolve(left)
    const resolvedRight = resolve(right)
    if (process.platform === 'win32') {
      return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    }
    return resolvedLeft === resolvedRight
  }

  private assertManagedHomePath(candidatePath: string): string {
    const wslInfo = parseWslUncPath(candidatePath)
    if (wslInfo) {
      if (
        !wslInfo.linuxPath.includes('/.local/share/orca/codex-accounts/') ||
        !wslInfo.linuxPath.endsWith('/home')
      ) {
        throw new Error('Managed WSL Codex home is outside Orca account storage.')
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
                  'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
                  'candidate_real=$(readlink -f -- "$candidate")',
                  'managed_root_real=$(readlink -f -- "$managed_root")',
                  'test -f "$candidate_real/.orca-managed-home"',
                  'case "$candidate_real" in "$managed_root_real"/*/home) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
                ].join('\n')
              )
            ],
            { encoding: 'utf-8', timeout: 5000 }
          ).trim()
          if (!canonicalLinuxPath) {
            throw new Error('Managed Codex home directory does not exist on disk.')
          }
          return toWindowsWslPath(canonicalLinuxPath, wslInfo.distro)
        } catch (error) {
          throw new Error('Managed WSL Codex home is outside Orca account storage.', {
            cause: error
          })
        }
      }

      if (wslInfo.linuxPath.split('/').includes('..')) {
        throw new Error('Managed WSL Codex home is outside Orca account storage.')
      }
      if (!existsSync(candidatePath)) {
        throw new Error('Managed Codex home directory does not exist on disk.')
      }
      if (!existsSync(join(candidatePath, '.orca-managed-home'))) {
        throw new Error('Managed Codex home is missing Orca ownership marker.')
      }
      return candidatePath
    }

    const rootPath = this.getManagedAccountsRoot()
    const resolvedCandidate = resolve(candidatePath)
    const resolvedRoot = resolve(rootPath)

    if (!existsSync(resolvedCandidate)) {
      throw new Error('Managed Codex home directory does not exist on disk.')
    }

    // realpath() requires the leaf to exist; verify the canonical on-disk target rather than trusting persisted text.
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(resolvedRoot)

    // Why: both sides must be canonical — macOS /var/folders realpaths to /private/var, else every managed home is rejected.
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

  private safeRemoveWslManagedHomeCandidate(
    distro: string,
    linuxHomePath: string,
    expectedAccountId: string
  ): void {
    // Why: creation can fail after mkdir/marker but before trust, so cleanup must verify the marker/account ID inside WSL.
    try {
      execFileSync(
        'wsl.exe',
        [
          '-d',
          distro,
          '--',
          'bash',
          '-lc',
          buildEncodedWslBashCommand(
            [
              'set -euo pipefail',
              `candidate=${shellQuote(linuxHomePath)}`,
              `expected_marker=${shellQuote(expectedAccountId)}`,
              'managed_root="${HOME%/}/.local/share/orca/codex-accounts"',
              'candidate_real=$(readlink -f -- "$candidate" 2>/dev/null || true)',
              'managed_root_real=$(readlink -f -- "$managed_root" 2>/dev/null || true)',
              'test -n "$candidate_real"',
              'test -n "$managed_root_real"',
              'case "$candidate_real" in "$managed_root_real"/*/home) ;; *) exit 0 ;; esac',
              'test -f "$candidate_real/.orca-managed-home"',
              'test "$(cat "$candidate_real/.orca-managed-home")" = "$expected_marker"',
              'rm -rf -- "$candidate_real"',
              'parent_dir=$(dirname -- "$candidate_real")',
              'case "$parent_dir" in "$managed_root_real"/*) rmdir -- "$parent_dir" 2>/dev/null || true ;; esac'
            ].join('\n')
          )
        ],
        { encoding: 'utf-8', timeout: 5000 }
      )
    } catch (error) {
      console.warn('[codex-accounts] Failed to clean up WSL managed home candidate:', error)
    }
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

    if (parseWslUncPath(managedHomePath)) {
      try {
        rmSync(dirname(managedHomePath), { recursive: true, force: true })
      } catch {
        // Best-effort cleanup
      }
      return
    }

    // Why: homes live at <accounts-root>/<uuid>/home; removing the home/ leaf leaves an empty <uuid>/ behind.
    try {
      const parentDir = resolve(managedHomePath, '..')
      // Why: canonicalize the root too so the prefix check works on macOS where userData resolves through /private/var.
      const root = realpathSync(this.getManagedAccountsRoot())
      if (parentDir.startsWith(root + sep) && parentDir !== root) {
        rmSync(parentDir, { recursive: true, force: true })
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async runCodexLogin(managedHomePath: string): Promise<void> {
    const wslInfo = parseWslUncPath(managedHomePath)
    if (wslInfo) {
      this.assertWslCodexCliAvailable(wslInfo)
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const spawnConfig = wslInfo
        ? {
            command: 'wsl.exe',
            args: buildWslCodexLoginArgs(wslInfo.distro, wslInfo.linuxPath),
            env: process.env,
            codexCommand: 'codex'
          }
        : (() => {
            const codexCommand = resolveCodexCommand()
            // Why: Windows codex may be a .cmd/.bat; spawn+shell:true would trigger DEP0190, so invoke cmd.exe /c explicitly.
            const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(codexCommand, ['login'])
            return {
              command: spawnCmd,
              args: spawnArgs,
              env: {
                ...process.env,
                CODEX_HOME: managedHomePath
              },
              codexCommand
            }
          })()
      const child = spawn(spawnConfig.command, spawnConfig.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Why: prevents a console window flash for .cmd/.bat entrypoints routed through cmd.exe on Windows.
        windowsHide: true,
        env: spawnConfig.env
      })

      let settled = false
      let output = ''
      const appendOutput = (chunk: Buffer): void => {
        output = `${output}${chunk.toString()}`
        if (output.length > MAX_LOGIN_OUTPUT_CHARS) {
          output = output.slice(-MAX_LOGIN_OUTPUT_CHARS)
        }
      }

      let timeout: ReturnType<typeof setTimeout> | null = null
      const cleanupListeners = (): void => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        child.stdout.off('data', appendOutput)
        child.stderr.off('data', appendOutput)
        child.off('error', onError)
        child.off('close', onClose)
      }

      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        cleanupListeners()
        callback()
      }

      const timeoutError = new Error('Codex sign-in took too long to finish. Please try again.')
      timeout = setTimeout(() => {
        child.kill()
        settle(() => {
          rejectPromise(timeoutError)
        })
      }, LOGIN_TIMEOUT_MS)

      const onError = (error: Error): void => {
        settle(() => {
          const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
          // Why: ENOENT is ambiguous — missing codex binary or missing node in PATH; a resolved full path implies node is missing.
          const isBareCommand = spawnConfig.codexCommand === 'codex'
          const message = isEnoent
            ? isBareCommand
              ? 'Codex CLI not found.'
              : 'Codex CLI found but could not run — Node.js may not be in your PATH.'
            : error.message
          rejectPromise(new Error(message))
        })
      }

      const onClose = (code: number | null): void => {
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
      }

      child.stdout.on('data', appendOutput)
      child.stderr.on('data', appendOutput)
      child.on('error', onError)
      child.on('close', onClose)
    })
  }

  private assertWslCodexCliAvailable(wslInfo: { distro: string; linuxPath: string }): void {
    try {
      execFileSync('wsl.exe', buildWslCodexAvailabilityArgs(wslInfo.distro), {
        encoding: 'utf-8',
        timeout: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
      })
    } catch (error) {
      throw new Error(
        `Codex CLI is not available in WSL ${wslInfo.distro}. Install Codex in that distro or switch Account location to Windows.`,
        { cause: error }
      )
    }
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

    // Why: API-key auth files have no OAuth/JWT claims; return nulls so the caller fails cleanly instead of crashing.
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
