/* eslint-disable max-lines -- Why: this service owns the single runtime-home
contract for Codex inside Orca. Keeping path resolution, system-default
snapshots, auth materialization, and recovery together prevents account-switch
semantics from drifting across PTY launch, login, and quota fetch paths. */
import {
  copyFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, parse, relative } from 'node:path'
import { app } from 'electron'
import type { CodexManagedAccount } from '../../shared/types'
import type { Store } from '../persistence'
import { writeFileAtomically } from './fs-utils'

type CodexAuthIdentity = {
  email: string | null
  providerAccountId: string | null
  workspaceAccountId: string | null
}

type CodexSystemDefaultSnapshot = {
  authJson: string | null
}

type CodexReadBackResult = 'unchanged' | 'persisted' | 'rejected'
type CodexReadBackMatch =
  | {
      kind: 'matched'
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }
  | { kind: 'none' | 'ambiguous' }

export class CodexRuntimeHomeService {
  // Why: tracks whether auth.json is currently managed by Orca. When null,
  // Orca does NOT own auth.json and must not overwrite external changes
  // (e.g. user running `codex login` or another auth tool). The snapshot
  // restore only fires on the managed→system-default transition.
  private lastSyncedAccountId: string | null = null
  // Why: tracks the auth.json content Orca last wrote to ~/.codex/auth.json.
  // Between syncs, if the file differs, Codex CLI refreshed the token — so
  // Orca writes back the refreshed token to managed storage before overwriting.
  // On managed→system-default transition, if the file differs, an external
  // login (e.g. `codex auth login`) overwrote it — so Orca adopts the file as
  // the new system default instead of restoring a stale snapshot.
  private lastWrittenAuthJson: string | null = null
  private skipNextReadBackForAccountId: string | null = null

  constructor(private readonly store: Store) {
    this.safeMigrateLegacyManagedState()
    this.initializeLastSyncedState()
    this.safeSyncForCurrentSelection()
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = settings.activeCodexManagedAccountId
  }

  prepareForCodexLaunch(): string {
    this.syncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  prepareForRateLimitFetch(): string {
    this.syncForCurrentSelection()
    return this.getRuntimeHomePath()
  }

  syncForCurrentSelection(): void {
    const settings = this.store.getSettings()
    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: false })
    }
    const activeAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      settings.activeCodexManagedAccountId
    )
    const previousAccount = this.getActiveAccount(
      settings.codexManagedAccounts,
      this.lastSyncedAccountId
    )
    let outgoingReadBackResult: CodexReadBackResult = 'unchanged'
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      outgoingReadBackResult = this.readBackRefreshedTokensForAccount(previousAccount, {
        updateLastWrittenAuthJson: true
      })
    }
    if (!activeAccount) {
      if (settings.activeCodexManagedAccountId) {
        this.store.updateSettings({ activeCodexManagedAccountId: null })
      }
      // Why: only restore the snapshot when transitioning FROM a managed
      // account back to system default. When no managed account was ever
      // active, auth.json belongs to the user and Orca must not touch it.
      // This prevents overwriting external auth changes (codex login or other
      // tools) on every PTY launch / rate-limit fetch.
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot({
          detectExternalLogin: outgoingReadBackResult !== 'rejected'
        })
        this.lastSyncedAccountId = null
      }
      return
    }

    const activeAuthPath = join(activeAccount.managedHomePath, 'auth.json')
    if (!existsSync(activeAuthPath)) {
      console.warn(
        '[codex-runtime-home] Active managed account is missing auth.json, restoring system default'
      )
      this.store.updateSettings({ activeCodexManagedAccountId: null })
      if (this.lastSyncedAccountId !== null) {
        this.restoreSystemDefaultSnapshot({ detectExternalLogin: true })
        this.lastSyncedAccountId = null
      }
      return
    }

    if (this.lastSyncedAccountId === null) {
      this.captureSystemDefaultSnapshot({ force: true })
    }

    // Why: Codex CLI refreshes expired OAuth tokens and writes them back to
    // ~/.codex/auth.json. If we detect the runtime file differs from what Orca
    // last wrote, the CLI must have refreshed — so we preserve those tokens
    // back to managed storage before overwriting runtime with managed state.
    if (this.lastSyncedAccountId === activeAccount.id) {
      if (this.skipNextReadBackForAccountId === activeAccount.id) {
        this.skipNextReadBackForAccountId = null
      } else {
        this.readBackRefreshedTokens({
          updateLastWrittenAuthJson: true
        })
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    }
    this.lastSyncedAccountId = activeAccount.id
    this.writeRuntimeAuth(readFileSync(activeAuthPath, 'utf-8'))
  }

  // Why: called by CodexAccountService before syncForCurrentSelection() after
  // re-auth or add-account. Those flows write fresh tokens to managed storage,
  // so the read-back must be skipped to avoid overwriting them with stale
  // runtime tokens.
  clearLastWrittenAuthJson(accountId = this.store.getSettings().activeCodexManagedAccountId): void {
    if (accountId === this.store.getSettings().activeCodexManagedAccountId) {
      this.lastWrittenAuthJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }

  private readBackRefreshedTokens(options: {
    updateLastWrittenAuthJson: boolean
  }): CodexReadBackResult {
    try {
      const runtimeAuthPath = this.getRuntimeAuthPath()
      if (!existsSync(runtimeAuthPath)) {
        return 'unchanged'
      }

      const runtimeContents = readFileSync(runtimeAuthPath, 'utf-8')
      if (this.lastWrittenAuthJson !== null && runtimeContents === this.lastWrittenAuthJson) {
        return 'unchanged'
      }

      const match = this.findManagedAccountForRuntimeAuth(runtimeContents)
      if (match.kind !== 'matched') {
        if (match.kind === 'ambiguous') {
          console.warn('[codex-runtime-home] Refusing ambiguous Codex auth read-back')
        }
        return 'rejected'
      }
      // Why: after app restart, Orca has no last-written baseline. Identity
      // alone cannot prove runtime auth is newer than managed storage.
      if (
        this.lastWrittenAuthJson === null &&
        !this.runtimeAuthIsFresher(runtimeContents, match.managedAuthContents)
      ) {
        return 'rejected'
      }

      writeFileAtomically(match.managedAuthPath, runtimeContents, { mode: 0o600 })
      if (options.updateLastWrittenAuthJson) {
        this.lastWrittenAuthJson = runtimeContents
      }
      return 'persisted'
    } catch (error) {
      // Why: read-back is best-effort. A transient fs error must not block the
      // forward sync path — the worst case is one more stale-token cycle, which
      // is strictly better than failing the entire sync.
      console.warn('[codex-runtime-home] Failed to read back refreshed tokens:', error)
      return 'rejected'
    }
  }

  private readBackRefreshedTokensForAccount(
    _account: CodexManagedAccount,
    options: { updateLastWrittenAuthJson: boolean }
  ): CodexReadBackResult {
    return this.readBackRefreshedTokens(options)
  }

  private safeSyncForCurrentSelection(): void {
    try {
      this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to sync runtime auth state:', error)
    }
  }

  private getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null {
    if (!activeAccountId) {
      return null
    }
    return accounts.find((account) => account.id === activeAccountId) ?? null
  }

  private findManagedAccountForRuntimeAuth(runtimeAuthContents: string): CodexReadBackMatch {
    const matches: {
      account: CodexManagedAccount
      managedAuthPath: string
      managedAuthContents: string
    }[] = []
    for (const account of this.store.getSettings().codexManagedAccounts) {
      const managedAuthPath = join(account.managedHomePath, 'auth.json')
      if (!existsSync(managedAuthPath)) {
        continue
      }
      const managedAuthContents = readFileSync(managedAuthPath, 'utf-8')
      if (this.runtimeAuthMatchesAccount(runtimeAuthContents, account, managedAuthContents)) {
        matches.push({ account, managedAuthPath, managedAuthContents })
      }
    }

    if (matches.length === 1) {
      return { kind: 'matched', ...matches[0] }
    }
    return { kind: matches.length === 0 ? 'none' : 'ambiguous' }
  }

  private runtimeAuthMatchesAccount(
    runtimeAuthContents: string,
    activeAccount: CodexManagedAccount,
    managedAuthContents: string
  ): boolean {
    const identity = this.readIdentityFromAuthContents(runtimeAuthContents)
    if (!identity) {
      return false
    }
    const managedIdentity = this.readIdentityFromAuthContents(managedAuthContents)

    // Why: old live Codex PTYs can still write refreshed tokens into the
    // shared runtime home after the user switches accounts. Never persist
    // that write into the newly active managed account unless the auth claims
    // still match the account Orca believes is selected.
    const selectedEmail = this.firstNonNull(
      this.normalizeField(activeAccount.email),
      managedIdentity?.email
    )
    const selectedProviderId = this.firstNonNull(
      this.normalizeField(activeAccount.providerAccountId),
      managedIdentity?.providerAccountId
    )
    const selectedWorkspaceId = this.firstNonNull(
      this.normalizeField(activeAccount.workspaceAccountId),
      managedIdentity?.workspaceAccountId
    )
    const emailMatches = Boolean(
      selectedEmail && identity.email && selectedEmail === identity.email
    )
    if (selectedEmail && identity.email && selectedEmail !== identity.email) {
      return false
    }
    if (!this.identityFieldMatches(selectedProviderId, identity.providerAccountId)) {
      return false
    }
    if (!this.identityFieldMatches(selectedWorkspaceId, identity.workspaceAccountId)) {
      return false
    }

    const hasStrongIdentity = Boolean(
      (selectedProviderId && identity.providerAccountId) ||
      (selectedWorkspaceId && identity.workspaceAccountId)
    )
    return (
      hasStrongIdentity ||
      (emailMatches && !identity.providerAccountId && !identity.workspaceAccountId)
    )
  }

  private runtimeAuthIsFresher(runtimeAuthContents: string, managedAuthContents: string): boolean {
    const runtimeFreshness = this.readFreshnessFromAuthContents(runtimeAuthContents)
    const managedFreshness = this.readFreshnessFromAuthContents(managedAuthContents)
    return (
      runtimeFreshness !== null && managedFreshness !== null && runtimeFreshness > managedFreshness
    )
  }

  private identityFieldMatches(selectedField: string | null, runtimeField: string | null): boolean {
    return !selectedField || Boolean(runtimeField && selectedField === runtimeField)
  }

  private firstNonNull(...values: (string | null | undefined)[]): string | null {
    return values.find((value): value is string => Boolean(value)) ?? null
  }

  private readIdentityFromAuthContents(contents: string): CodexAuthIdentity | null {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(contents) as Record<string, unknown>
    } catch {
      return null
    }

    const tokens = this.readRecordClaim(raw, 'tokens')
    const idToken = this.normalizeField(
      this.readStringClaim(tokens, 'id_token') ?? this.readStringClaim(tokens, 'idToken')
    )
    const payload = idToken ? this.parseJwtPayload(idToken) : null
    const authClaims = this.readRecordClaim(payload, 'https://api.openai.com/auth')
    const profileClaims = this.readRecordClaim(payload, 'https://api.openai.com/profile')

    return {
      email: this.normalizeField(
        this.readStringClaim(payload, 'email') ?? this.readStringClaim(profileClaims, 'email')
      ),
      providerAccountId: this.normalizeField(
        this.readStringClaim(tokens, 'account_id') ??
          this.readStringClaim(tokens, 'accountId') ??
          this.readStringClaim(authClaims, 'chatgpt_account_id') ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      ),
      workspaceAccountId: this.normalizeField(
        this.readStringClaim(authClaims, 'workspace_account_id') ??
          this.readStringClaim(tokens, 'account_id') ??
          this.readStringClaim(tokens, 'accountId') ??
          this.readStringClaim(payload, 'chatgpt_account_id')
      )
    }
  }

  private readFreshnessFromAuthContents(contents: string): number | null {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(contents) as Record<string, unknown>
    } catch {
      return null
    }

    const tokens = this.readRecordClaim(raw, 'tokens')
    const idToken = this.normalizeField(
      this.readStringClaim(tokens, 'id_token') ?? this.readStringClaim(tokens, 'idToken')
    )
    const payload = idToken ? this.parseJwtPayload(idToken) : null
    return (
      this.readNumberClaim(tokens, 'expires_at') ??
      this.readNumberClaim(tokens, 'expiresAt') ??
      this.readNumberClaim(tokens, 'expiry') ??
      this.readNumberClaim(tokens, 'expires') ??
      this.readNumberClaim(payload, 'exp') ??
      this.readNumberClaim(payload, 'iat')
    )
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

  private readNumberClaim(value: Record<string, unknown> | null, key: string): number | null {
    const claim = value?.[key]
    if (typeof claim === 'number' && Number.isFinite(claim)) {
      return claim
    }
    if (typeof claim === 'string') {
      const parsed = Number(claim)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  private normalizeField(value: string | null | undefined): string | null {
    if (!value) {
      return null
    }
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }

  private safeMigrateLegacyManagedState(): void {
    try {
      this.migrateLegacyManagedStateIfNeeded()
    } catch (error) {
      console.warn('[codex-runtime-home] Failed to migrate legacy managed Codex state:', error)
    }
  }

  private getRuntimeHomePath(): string {
    const runtimeHomePath = join(homedir(), '.codex')
    mkdirSync(runtimeHomePath, { recursive: true })
    return runtimeHomePath
  }

  private getRuntimeAuthPath(): string {
    return join(this.getRuntimeHomePath(), 'auth.json')
  }

  private getSystemDefaultSnapshotPath(): string {
    return join(this.getRuntimeMetadataDir(), 'system-default-auth.json')
  }

  private getRuntimeMetadataDir(): string {
    const metadataDir = join(app.getPath('userData'), 'codex-runtime-home')
    mkdirSync(metadataDir, { recursive: true })
    return metadataDir
  }

  private getMigrationMarkerPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-v1.json')
  }

  private getMigrationDiagnosticsPath(): string {
    return join(this.getRuntimeMetadataDir(), 'migration-diagnostics.jsonl')
  }

  private getManagedAccountsRoot(): string {
    return join(app.getPath('userData'), 'codex-accounts')
  }

  private migrateLegacyManagedStateIfNeeded(): void {
    if (existsSync(this.getMigrationMarkerPath())) {
      return
    }

    const managedHomes = this.getLegacyManagedHomes()
    for (const managedHomePath of managedHomes) {
      const accountId = parse(relative(this.getManagedAccountsRoot(), managedHomePath)).dir.split(
        /[\\/]/
      )[0]
      if (!accountId) {
        continue
      }
      this.migrateLegacyHistory(managedHomePath)
      this.migrateLegacySessions(managedHomePath, accountId)
    }

    // Why: migration is intentionally one-shot. Re-importing every startup
    // would keep replaying stale managed-home state back into ~/.codex and
    // make the shared runtime feel nondeterministic.
    writeFileAtomically(
      this.getMigrationMarkerPath(),
      `${JSON.stringify({ completedAt: Date.now(), migratedHomeCount: managedHomes.length })}\n`
    )
  }

  private getLegacyManagedHomes(): string[] {
    const managedAccountsRoot = this.getManagedAccountsRoot()
    if (!existsSync(managedAccountsRoot)) {
      return []
    }

    const accountEntries = readdirSync(managedAccountsRoot, { withFileTypes: true })
    const managedHomes: string[] = []
    for (const entry of accountEntries) {
      if (!entry.isDirectory()) {
        continue
      }
      const managedHomePath = join(managedAccountsRoot, entry.name, 'home')
      if (existsSync(join(managedHomePath, '.orca-managed-home'))) {
        managedHomes.push(managedHomePath)
      }
    }
    return managedHomes.sort()
  }

  private migrateLegacyHistory(managedHomePath: string): void {
    const legacyHistoryPath = join(managedHomePath, 'history.jsonl')
    if (!existsSync(legacyHistoryPath)) {
      return
    }

    const runtimeHistoryPath = join(this.getRuntimeHomePath(), 'history.jsonl')
    const existingLines = existsSync(runtimeHistoryPath)
      ? readFileSync(runtimeHistoryPath, 'utf-8').split('\n').filter(Boolean)
      : []
    const mergedLines = [...existingLines]
    const seenLines = new Set(existingLines)
    for (const line of readFileSync(legacyHistoryPath, 'utf-8').split('\n')) {
      if (!line || seenLines.has(line)) {
        continue
      }
      seenLines.add(line)
      mergedLines.push(line)
    }

    if (mergedLines.length === 0) {
      return
    }
    writeFileAtomically(runtimeHistoryPath, `${mergedLines.join('\n')}\n`)
  }

  private migrateLegacySessions(managedHomePath: string, accountId: string): void {
    const legacySessionsRoot = join(managedHomePath, 'sessions')
    if (!existsSync(legacySessionsRoot)) {
      return
    }

    const runtimeSessionsRoot = join(this.getRuntimeHomePath(), 'sessions')
    mkdirSync(runtimeSessionsRoot, { recursive: true })
    for (const legacyFilePath of this.listFilesRecursively(legacySessionsRoot)) {
      const relativePath = relative(legacySessionsRoot, legacyFilePath)
      const runtimeFilePath = join(runtimeSessionsRoot, relativePath)
      mkdirSync(dirname(runtimeFilePath), { recursive: true })
      if (!existsSync(runtimeFilePath)) {
        copyFileSync(legacyFilePath, runtimeFilePath)
        continue
      }

      const legacyContents = readFileSync(legacyFilePath)
      const runtimeContents = readFileSync(runtimeFilePath)
      if (runtimeContents.equals(legacyContents)) {
        continue
      }

      const preservedPath = this.getPreservedLegacySessionPath(runtimeFilePath, accountId)
      copyFileSync(legacyFilePath, preservedPath)
      this.appendMigrationDiagnostic({
        type: 'session-conflict',
        accountId,
        runtimeFilePath,
        preservedPath
      })
    }
  }

  private listFilesRecursively(rootPath: string): string[] {
    const stat = statSync(rootPath)
    if (!stat.isDirectory()) {
      return [rootPath]
    }

    const files: string[] = []
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      const childPath = join(rootPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...this.listFilesRecursively(childPath))
        continue
      }
      if (entry.isFile()) {
        files.push(childPath)
      }
    }
    return files.sort()
  }

  private getPreservedLegacySessionPath(runtimeFilePath: string, accountId: string): string {
    const extension = extname(runtimeFilePath)
    const basename = runtimeFilePath.slice(0, runtimeFilePath.length - extension.length)
    return `${basename}.orca-legacy-${accountId}${extension}`
  }

  private appendMigrationDiagnostic(record: Record<string, string>): void {
    const diagnosticsPath = this.getMigrationDiagnosticsPath()
    const existingContents = existsSync(diagnosticsPath)
      ? readFileSync(diagnosticsPath, 'utf-8')
      : ''
    writeFileAtomically(diagnosticsPath, `${existingContents}${JSON.stringify(record)}\n`)
  }

  private captureSystemDefaultSnapshot(options: { force: boolean }): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    const snapshot: CodexSystemDefaultSnapshot = {
      authJson: existsSync(runtimeAuthPath) ? readFileSync(runtimeAuthPath, 'utf-8') : null
    }
    writeFileAtomically(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  }

  private restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void {
    // Why: detect whether an external tool (e.g. `codex auth login`) overwrote
    // auth.json while a managed account was active. If so, that external login
    // becomes the new system default — skip the stale snapshot restore.
    if (options.detectExternalLogin && this.detectExternalLoginAndUpdateSnapshot()) {
      return
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!existsSync(snapshotPath)) {
      rmSync(this.getRuntimeAuthPath(), { force: true })
      this.lastWrittenAuthJson = null
      return
    }

    const snapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (!snapshot) {
      console.warn('[codex-runtime-home] Ignoring invalid system-default auth snapshot')
      rmSync(snapshotPath, { force: true })
      rmSync(this.getRuntimeAuthPath(), { force: true })
      this.lastWrittenAuthJson = null
      return
    }
    if (snapshot.authJson === null) {
      rmSync(this.getRuntimeAuthPath(), { force: true })
      this.lastWrittenAuthJson = null
      return
    }
    this.writeRuntimeAuth(snapshot.authJson)
  }

  // Why: mirrors ClaudeRuntimeAuthService.detectExternalLoginAndUpdateSnapshot().
  // If the runtime auth.json differs from what Orca last wrote, something
  // external changed it. That external state should become the new system
  // default rather than being overwritten by a potentially stale snapshot.
  private detectExternalLoginAndUpdateSnapshot(): boolean {
    if (this.lastWrittenAuthJson === null) {
      return false
    }

    const runtimeAuthPath = this.getRuntimeAuthPath()
    if (!existsSync(runtimeAuthPath)) {
      const snapshotPath = this.getSystemDefaultSnapshotPath()
      rmSync(snapshotPath, { force: true })
      this.lastWrittenAuthJson = null
      return true
    }

    try {
      const currentAuth = readFileSync(runtimeAuthPath, 'utf-8')
      if (currentAuth === this.lastWrittenAuthJson) {
        return false
      }
    } catch {
      return false
    }

    const snapshotPath = this.getSystemDefaultSnapshotPath()
    rmSync(snapshotPath, { force: true })
    this.lastWrittenAuthJson = null
    return true
  }

  private writeRuntimeAuth(contents: string): void {
    // Why: auth.json contains sensitive credentials. Restrict to owner-only
    // so other users on a shared Linux/macOS machine cannot read it.
    if (this.fileContentsEqual(this.getRuntimeAuthPath(), contents)) {
      this.ensureOwnerOnlyMode(this.getRuntimeAuthPath())
      this.lastWrittenAuthJson = contents
      return
    }
    writeFileAtomically(this.getRuntimeAuthPath(), contents, { mode: 0o600 })
    this.lastWrittenAuthJson = contents
  }

  private fileContentsEqual(targetPath: string, contents: string): boolean {
    try {
      return existsSync(targetPath) && readFileSync(targetPath, 'utf-8') === contents
    } catch {
      return false
    }
  }

  private ensureOwnerOnlyMode(targetPath: string): void {
    if (process.platform === 'win32') {
      return
    }
    try {
      chmodSync(targetPath, 0o600)
    } catch {
      /* Best effort: the next atomic write will set the restrictive mode. */
    }
  }

  private readSystemDefaultSnapshot(snapshotPath: string): CodexSystemDefaultSnapshot | null {
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        'authJson' in parsed &&
        (typeof parsed.authJson === 'string' || parsed.authJson === null)
      ) {
        return parsed as CodexSystemDefaultSnapshot
      }
    } catch {
      return null
    }
    return null
  }

  clearSystemDefaultSnapshot(): void {
    rmSync(this.getSystemDefaultSnapshotPath(), { force: true })
  }
}
