/* eslint-disable max-lines -- Why: this module keeps Claude credential source
ordering, OAuth usage fetch semantics, and PTY fallback behavior together so
subscription usage state cannot drift across code paths. */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net, session } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata,
  UsageRateLimitSource
} from '../../shared/rate-limit-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import { fetchViaPty } from './claude-pty'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials
} from '../claude-accounts/keychain'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from '../claude-accounts/managed-auth-path'
import { writeManagedClaudeKeychainCredentials } from '../claude-accounts/keychain'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import { createOAuthUsageError, OAuthUsageError } from './claude-oauth-usage-error'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { resolveClaudeUsageRefreshPlan } from './claude-usage-refresh-plan'
import {
  classifyClaudeCredentialAbsence,
  classifyClaudeOAuthUsageError,
  type ClaudeUsageErrorClassification
} from './claude-usage-error-classification'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.0'
const API_TIMEOUT_MS = 10_000
const LIVE_CLAUDE_REFRESH_DEFERRED_MESSAGE =
  'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'

/**
 * Bridge standard HTTP proxy env vars into Electron's session proxy config.
 *
 * Why: Electron's net.fetch uses Chromium's networking stack which respects
 * OS-level proxy settings but ignores HTTP_PROXY / HTTPS_PROXY env vars.
 * Users in regions where api.anthropic.com is only reachable via proxy (see
 * #521, #800) often set these env vars rather than configuring system proxy.
 * Without this bridge, the usage indicator silently fails and the app may hit
 * Anthropic from an unexpected IP, risking rate-limit signals on the account.
 */
async function ensureProxyFromEnv(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_USAGE_URL
  }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Credential reading — tries multiple sources for an OAuth bearer token
// ---------------------------------------------------------------------------

type KeychainCredentials = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

type OAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: OAuthCredentialSource
  keychainUnavailable?: boolean
}

type OAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
}

type OAuthCredentialSource = 'scoped-keychain' | 'legacy-keychain' | 'credentials-file' | 'none'

// Why: factored out so both the active-account Keychain reader and the
// managed-account reader share the same JSON parsing + refreshability check.
function parseOAuthCredentialsJson(
  raw: string,
  source: OAuthCredentialSource
): OAuthCredentialReadResult {
  try {
    const parsed = JSON.parse(raw) as KeychainCredentials
    const oauth = parsed?.claudeAiOauth
    const token = oauth?.accessToken
    const refreshToken = oauth?.refreshToken
    const hasRefreshableCredentials = typeof refreshToken === 'string' && refreshToken.trim() !== ''
    if (!token || typeof token !== 'string') {
      return {
        token: null,
        hasRefreshableCredentials,
        source
      }
    }
    // Why: Claude's local expiresAt metadata is not authoritative for the
    // /api/oauth/usage endpoint. Real Claude Code 2.1 credentials have been
    // observed authenticating there after expiresAt, so let the server decide.
    return {
      token,
      hasRefreshableCredentials,
      source
    }
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

function emptyOAuthCredentialReadResult(): OAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false,
    source: 'none'
  }
}

function keychainUnavailableOAuthCredentialReadResult(): OAuthCredentialReadResult {
  return {
    token: null,
    hasRefreshableCredentials: false,
    source: 'none',
    keychainUnavailable: true
  }
}

/**
 * Read OAuth token from macOS Keychain.
 * Why: Claude Code 2.1+ scopes OAuth Keychain services by CLAUDE_CONFIG_DIR;
 * older builds used the legacy unsuffixed service. The shared reader handles both.
 */
async function readFromKeychain(configDir?: string): Promise<OAuthCredentialReadResult> {
  if (process.platform !== 'darwin') {
    return emptyOAuthCredentialReadResult()
  }

  if (configDir) {
    const scopedCredentials = await readCredentialsFromStrictKeychain(configDir, 'scoped-keychain')
    if (scopedCredentials.token) {
      return scopedCredentials
    }
    const legacyCredentials = await readCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
    // Why: Orca cannot refresh tokens itself, so an actual access token from
    // either item beats refresh-only credentials. A scoped item the CLI stopped
    // maintaining must not shadow a still-working legacy token.
    if (legacyCredentials.token) {
      return legacyCredentials
    }
    if (scopedCredentials.hasRefreshableCredentials) {
      return scopedCredentials
    }
    if (legacyCredentials.hasRefreshableCredentials) {
      return legacyCredentials
    }
    return scopedCredentials.keychainUnavailable || legacyCredentials.keychainUnavailable
      ? keychainUnavailableOAuthCredentialReadResult()
      : legacyCredentials
  }

  try {
    const credentials = await readActiveClaudeKeychainCredentials(configDir)
    return credentials
      ? parseOAuthCredentialsJson(credentials, 'legacy-keychain')
      : emptyOAuthCredentialReadResult()
  } catch {
    return keychainUnavailableOAuthCredentialReadResult()
  }
}

async function readCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: OAuthCredentialSource
): Promise<OAuthCredentialReadResult> {
  try {
    const credentials = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return credentials
      ? parseOAuthCredentialsJson(credentials, source)
      : emptyOAuthCredentialReadResult()
  } catch {
    return keychainUnavailableOAuthCredentialReadResult()
  }
}

/**
 * Read OAuth token from ~/.claude/.credentials.json (legacy path).
 * Why: older Claude CLI versions store credentials in this plain JSON
 * file. We keep it as a fallback for compatibility.
 */
async function readFromCredentialsFile(configDir?: string): Promise<OAuthCredentialReadResult> {
  const credPath = path.join(configDir ?? path.join(homedir(), '.claude'), '.credentials.json')
  try {
    const raw = await readFile(credPath, 'utf-8')
    return parseOAuthCredentialsJson(raw, 'credentials-file')
  } catch {
    return emptyOAuthCredentialReadResult()
  }
}

/**
 * Try credential sources that yield a genuine OAuth bearer token.
 * Why: we intentionally do NOT read ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 * here — those are API keys which return 401 on the OAuth usage endpoint.
 * API-key users are served by the PTY fallback instead.
 */
async function readOAuthCredentials(
  options?: OAuthCredentialReadOptions
): Promise<OAuthCredentialReadResult> {
  // 1. macOS Keychain (Claude Max/Pro OAuth)
  const fromKeychain = await readFromKeychain(options?.keychainConfigDir)
  if (fromKeychain.token) {
    return fromKeychain
  }
  if (fromKeychain.hasRefreshableCredentials) {
    return fromKeychain
  }

  // 2. Legacy credentials file
  const fromFile = await readFromCredentialsFile(options?.credentialsFileConfigDir)
  if (fromFile.token) {
    return fromFile
  }
  if (fromFile.hasRefreshableCredentials) {
    return fromFile
  }

  if (fromKeychain.keychainUnavailable) {
    return fromKeychain
  }

  return emptyOAuthCredentialReadResult()
}

function resolveOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): OAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  // Why: Claude Code 2.1+ can scope even the default config dir's macOS
  // Keychain item. Try scoped first, with legacy still handled as fallback.
  const readOptions: OAuthCredentialReadOptions = {
    credentialsFileConfigDir: authPreparation.configDir,
    keychainConfigDir: authPreparation.configDir
  }
  return readOptions
}

function buildClaudeUsageFetchDiagnostic(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  oauthCredentials: OAuthCredentialReadResult
): Record<string, unknown> {
  return {
    provenance: authPreparation?.provenance ?? 'system',
    runtime: authPreparation?.runtime ?? 'host',
    wslDistro: authPreparation?.wslDistro ?? null,
    hasExplicitClaudeConfigDir: Boolean(authPreparation?.envPatch.CLAUDE_CONFIG_DIR),
    credentialSource: oauthCredentials.source,
    keychainUnavailable: oauthCredentials.keychainUnavailable,
    hasRefreshableCredentials: oauthCredentials.hasRefreshableCredentials
  }
}

function warnClaudeUsageFetchFailure(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  oauthCredentials: OAuthCredentialReadResult,
  error: unknown
): void {
  const message = error instanceof Error ? error.message : String(error)
  const status = error instanceof OAuthUsageError ? error.status : null
  console.warn('[claude-rate-limits] Claude usage refresh failed', {
    ...buildClaudeUsageFetchDiagnostic(authPreparation, oauthCredentials),
    status,
    message
  })
}

// ---------------------------------------------------------------------------
// OAuth API fetch
// ---------------------------------------------------------------------------

type OAuthUsageWindow = {
  utilization?: number
  used_percentage?: number
  resets_at?: string | number
}

type OAuthUsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  is_active?: boolean
  scope?: { model?: { display_name?: string } | null } | null
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
  fable_weekly?: OAuthUsageWindow
  fable_seven_day?: OAuthUsageWindow
  seven_day_fable?: OAuthUsageWindow
  limits?: OAuthUsageLimit[] | null
}

type ClaudeUsageAttemptState = {
  attemptedSources: UsageRateLimitSource[]
}

function abortedClaudeRateLimitResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error'
  }
}

function parseResetTimestamp(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }
    return value > 10_000_000_000 ? value : value * 1000
  }

  if (!value) {
    return null
  }

  const numericValue = Number(value)
  if (Number.isFinite(numericValue) && value.trim() !== '') {
    return numericValue > 10_000_000_000 ? numericValue : numericValue * 1000
  }

  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function parseResetDescription(resetValue: string | number | undefined): string | null {
  const resetTimestamp = parseResetTimestamp(resetValue)
  if (resetTimestamp === null) {
    return null
  }
  try {
    const date = new Date(resetTimestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return null
  }
}

function mapWindow(
  raw: OAuthUsageWindow | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!raw) {
    return null
  }
  const usedPercent =
    typeof raw.utilization === 'number'
      ? raw.utilization
      : typeof raw.used_percentage === 'number'
        ? raw.used_percentage
        : null
  if (usedPercent === null) {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: parseResetTimestamp(raw.resets_at),
    resetDescription: parseResetDescription(raw.resets_at)
  }
}

function mapFableWeeklyWindow(data: OAuthUsageResponse): RateLimitWindow | null {
  // Why: model quotas moved into structured scoped limits; prefer that current
  // contract while retaining explicit legacy weekly fields for older responses.
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          // Why: is_active marks the currently-binding limit, not data validity;
          // inactive Fable entries still carry a real percent/resets_at (#8979).
          limit?.kind === 'weekly_scoped' &&
          Number.isFinite(limit.percent) &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === 'fable'
      )
    : undefined
  return (
    mapWindow(
      scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined,
      10080
    ) ??
    mapWindow(data.fable_weekly, 10080) ??
    mapWindow(data.fable_seven_day, 10080) ??
    mapWindow(data.seven_day_fable, 10080)
  )
}

async function fetchViaOAuth(token: string, signal?: AbortSignal): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  await ensureProxyFromEnv()
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  // Compose the caller's cancel signal with the request timeout so a timeout
  // and an external cancel both abort the fetch.
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  try {
    // Why: net.fetch uses Chromium's networking stack which respects OS proxy
    // settings and certificates. Env var proxies are bridged by ensureProxyFromEnv.
    const res = await net.fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        // Why: Claude's OAuth usage endpoint is the Claude Code usage API;
        // matching the CLI user-agent keeps Orca aligned with that contract.
        'User-Agent': CLAUDE_CODE_USER_AGENT
      },
      signal: requestSignal
    })

    if (!res.ok) {
      throw await createOAuthUsageError(res)
    }

    const data = (await res.json()) as OAuthUsageResponse
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }

    return {
      provider: 'claude',
      session: mapWindow(data.five_hour, 300),
      weekly: mapWindow(data.seven_day, 10080),
      fableWeekly: mapFableWeeklyWindow(data),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (err) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    throw err
  }
}

function recordAttempt(
  state: ClaudeUsageAttemptState,
  source: UsageRateLimitSource
): UsageRateLimitSource[] {
  if (!state.attemptedSources.includes(source)) {
    state.attemptedSources.push(source)
  }
  return state.attemptedSources
}

function withClaudeUsageMetadata(
  limits: ProviderRateLimits,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    ...limits,
    usageMetadata: {
      ...limits.usageMetadata,
      ...metadata,
      attemptedSources: metadata.attemptedSources ?? limits.usageMetadata?.attemptedSources
    }
  }
}

function makeClaudeUsageResult(
  status: ProviderRateLimits['status'],
  error: string | null,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: metadata
  }
}

function metadataForAttempt(input: {
  attemptedSources: UsageRateLimitSource[]
  oauthCredentials: OAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
  source?: UsageRateLimitSource
  failureKind?: UsageRateLimitFailureKind
  deferredByLiveClaudeSession?: boolean
}): UsageRateLimitMetadata {
  return {
    source: input.source,
    attemptedSources: [...input.attemptedSources],
    failureKind: input.failureKind,
    credentialSource: input.oauthCredentials.source,
    authProvenance: input.authPreparation?.provenance ?? 'system',
    deferredByLiveClaudeSession: input.deferredByLiveClaudeSession
  }
}

function classifyClaudeCliUsageFailure(
  limits: ProviderRateLimits
): UsageRateLimitFailureKind | undefined {
  if (!limits.error) {
    return undefined
  }
  if (/rate limited/i.test(limits.error)) {
    return 'rate-limited'
  }
  if (/plan usage is unavailable|usage is unavailable/i.test(limits.error)) {
    return 'usage-unavailable'
  }
  return 'cli-unavailable'
}

async function fetchClaudeUsageViaCli(input: {
  authPreparation?: ClaudeRuntimeAuthPreparation
  oauthCredentials: OAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  recordAttempt(input.attempts, 'cli')
  const limits = await fetchViaPty({
    authPreparation: input.authPreparation,
    networkProxySettings: input.networkProxySettings,
    signal: input.signal
  })
  return withClaudeUsageMetadata(
    limits,
    metadataForAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      source: 'cli',
      failureKind: classifyClaudeCliUsageFailure(limits)
    })
  )
}

function isManagedClaudeAuth(authPreparation: ClaudeRuntimeAuthPreparation | undefined): boolean {
  return authPreparation?.provenance.startsWith('managed:') === true
}

function canSupplementOAuthUsageFromCli(input: {
  oauthLimits: ProviderRateLimits
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowUsagePanelSupplement: boolean
}): boolean {
  // Why: Fable is visible in Claude's interactive /usage panel even when the
  // OAuth usage endpoint only reports documented 5h/7d windows. This runs only
  // after OAuth succeeds, so it must not become a broad auth-recovery fallback.
  return Boolean(
    input.allowUsagePanelSupplement &&
    !input.authPreparation?.managedRefreshDeferredByLivePty &&
    !input.oauthLimits.fableWeekly &&
    (input.oauthLimits.session || input.oauthLimits.weekly)
  )
}

function mergeClaudeUsageWindows(
  primary: ProviderRateLimits,
  supplement: ProviderRateLimits | null
): ProviderRateLimits {
  if (!supplement) {
    return primary
  }
  return {
    ...primary,
    session: primary.session ?? supplement.session,
    weekly: primary.weekly ?? supplement.weekly,
    fableWeekly: primary.fableWeekly ?? supplement.fableWeekly ?? null
  }
}

async function supplementOAuthUsageFromCli(input: {
  oauthLimits: ProviderRateLimits
  authPreparation?: ClaudeRuntimeAuthPreparation
  oauthCredentials: OAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  allowUsagePanelSupplement: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  if (input.signal?.aborted || !canSupplementOAuthUsageFromCli(input)) {
    return input.oauthLimits
  }
  try {
    const cliLimits = await fetchClaudeUsageViaCli({
      authPreparation: input.authPreparation,
      oauthCredentials: input.oauthCredentials,
      attempts: input.attempts,
      networkProxySettings: input.networkProxySettings,
      signal: input.signal
    })
    return mergeClaudeUsageWindows(input.oauthLimits, cliLimits)
  } catch (err) {
    warnClaudeUsageFetchFailure(input.authPreparation, input.oauthCredentials, err)
    return input.oauthLimits
  }
}

async function completeOAuthUsageSuccess(input: {
  oauthLimits: ProviderRateLimits
  oauthCredentials: OAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  options?: FetchClaudeRateLimitsOptions
}): Promise<ProviderRateLimits> {
  const limits = await supplementOAuthUsageFromCli({
    oauthLimits: input.oauthLimits,
    authPreparation: input.options?.authPreparation,
    oauthCredentials: input.oauthCredentials,
    attempts: input.attempts,
    networkProxySettings: input.options?.networkProxySettings,
    allowUsagePanelSupplement:
      input.options?.allowUsagePanelSupplement ??
      isManagedClaudeAuth(input.options?.authPreparation),
    signal: input.options?.signal
  })
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  return withClaudeUsageMetadata(
    limits,
    metadataForAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.options?.authPreparation,
      source: 'oauth'
    })
  )
}

function canRetryWithLegacyKeychainToken(input: {
  classification: ClaudeUsageErrorClassification
  oauthCredentials: OAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): boolean {
  // Why: the CLI only maintains the legacy keychain item for the default config
  // dir, so a scoped item can hold a token that expired long ago and will 401
  // on every fetch with no recovery path. Host system-default auth may retry
  // with the legacy item; managed/WSL credentials must never be answered with
  // the host user's legacy keychain account.
  return (
    input.classification.failureKind === 'stale-token' &&
    input.oauthCredentials.source === 'scoped-keychain' &&
    (input.authPreparation?.runtime ?? 'host') === 'host' &&
    !isManagedClaudeAuth(input.authPreparation)
  )
}

async function retryOAuthWithLegacyKeychainToken(input: {
  failedToken: string | null
  attempts: ClaudeUsageAttemptState
  options?: FetchClaudeRateLimitsOptions
}): Promise<ProviderRateLimits | null> {
  const legacyCredentials = await readCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
  if (!legacyCredentials.token || legacyCredentials.token === input.failedToken) {
    return null
  }
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  try {
    const oauthLimits = await fetchViaOAuth(legacyCredentials.token, input.options?.signal)
    if (input.options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    return await completeOAuthUsageSuccess({
      oauthLimits,
      oauthCredentials: legacyCredentials,
      attempts: input.attempts,
      options: input.options
    })
  } catch (err) {
    warnClaudeUsageFetchFailure(input.options?.authPreparation, legacyCredentials, err)
    return null
  }
}

function shouldDeferForLiveClaude(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  classification: ClaudeUsageErrorClassification
): boolean {
  return Boolean(
    authPreparation?.managedRefreshDeferredByLivePty &&
    (classification.failureKind === 'stale-token' ||
      classification.failureKind === 'refreshable-credentials-without-token' ||
      classification.failureKind === 'deferred-by-live-session')
  )
}

function liveClaudeDeferredResult(input: {
  attempts: ClaudeUsageAttemptState
  oauthCredentials: OAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  return makeClaudeUsageResult('error', LIVE_CLAUDE_REFRESH_DEFERRED_MESSAGE, {
    ...metadataForAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: 'deferred-by-live-session',
      deferredByLiveClaudeSession: true
    })
  })
}

function errorResultForClassification(input: {
  error: unknown
  classification: ClaudeUsageErrorClassification
  attempts: ClaudeUsageAttemptState
  oauthCredentials: OAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error || 'Unknown error')
  return makeClaudeUsageResult('error', withMacTailscaleDnsHint(message), {
    ...metadataForAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: input.classification.failureKind
    })
  })
}

async function attemptCliRepairThenRetryOAuth(input: {
  options?: FetchClaudeRateLimitsOptions
  attempts: ClaudeUsageAttemptState
  oauthCredentials: OAuthCredentialReadResult
}): Promise<ProviderRateLimits | null> {
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  let cliResult: ProviderRateLimits | null = null
  try {
    cliResult = await fetchClaudeUsageViaCli({
      authPreparation: input.options?.authPreparation,
      oauthCredentials: input.oauthCredentials,
      attempts: input.attempts,
      networkProxySettings: input.options?.networkProxySettings,
      signal: input.options?.signal
    })
  } catch (err) {
    warnClaudeUsageFetchFailure(input.options?.authPreparation, input.oauthCredentials, err)
  }

  // Why: bail before credential I/O if the fetch cycle was stopped mid-CLI-repair.
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  const refreshedCredentials = await readOAuthCredentials(
    resolveOAuthCredentialReadOptions(input.options?.authPreparation)
  )
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (refreshedCredentials.token) {
    recordAttempt(input.attempts, 'oauth')
    try {
      const oauthRetry = await fetchViaOAuth(refreshedCredentials.token, input.options?.signal)
      if (input.options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      const supplemented = mergeClaudeUsageWindows(oauthRetry, cliResult)
      return withClaudeUsageMetadata(
        supplemented,
        metadataForAttempt({
          attemptedSources: input.attempts.attemptedSources,
          oauthCredentials: refreshedCredentials,
          authPreparation: input.options?.authPreparation,
          source: 'oauth'
        })
      )
    } catch (err) {
      warnClaudeUsageFetchFailure(input.options?.authPreparation, refreshedCredentials, err)
    }
  }

  return cliResult
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FetchClaudeRateLimitsOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowPtyFallback?: boolean
  allowUsagePanelSupplement?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export type FetchManagedAccountUsageOptions = {
  allowUsagePanelSupplement?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export async function fetchClaudeRateLimits(
  options?: FetchClaudeRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const attempts: ClaudeUsageAttemptState = { attemptedSources: [] }
  const allowCliFallback = options?.allowPtyFallback !== false
  const plan = resolveClaudeUsageRefreshPlan({
    authPreparation: options?.authPreparation,
    allowCliFallback
  })

  if (options?.authPreparation?.runtime === 'wsl' && !options.authPreparation.wslLinuxConfigDir) {
    return makeClaudeUsageResult(
      'error',
      `WSL Claude config unavailable for ${options.authPreparation.wslDistro ?? 'default distro'}`,
      {
        attemptedSources: [],
        failureKind: 'cli-unavailable',
        authProvenance: options.authPreparation.provenance
      }
    )
  }

  const oauthCredentials = await readOAuthCredentials(
    resolveOAuthCredentialReadOptions(options?.authPreparation)
  )
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  if (plan.steps.some((step) => step.source === 'oauth') && oauthCredentials.token) {
    recordAttempt(attempts, 'oauth')
    try {
      const oauthLimits = await fetchViaOAuth(oauthCredentials.token, options?.signal)
      if (options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      return await completeOAuthUsageSuccess({ oauthLimits, oauthCredentials, attempts, options })
    } catch (err) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, err)
      const classification = classifyClaudeOAuthUsageError(err)

      if (
        canRetryWithLegacyKeychainToken({
          classification,
          oauthCredentials,
          authPreparation: options?.authPreparation
        })
      ) {
        const legacyResult = await retryOAuthWithLegacyKeychainToken({
          failedToken: oauthCredentials.token,
          attempts,
          options
        })
        if (legacyResult) {
          return legacyResult
        }
      }

      if (shouldDeferForLiveClaude(options?.authPreparation, classification)) {
        return liveClaudeDeferredResult({
          attempts,
          oauthCredentials,
          authPreparation: options?.authPreparation
        })
      }

      if (classification.shouldAttemptDelegatedRefresh && allowCliFallback) {
        const repaired = await attemptCliRepairThenRetryOAuth({
          options,
          attempts,
          oauthCredentials
        })
        if (repaired) {
          return repaired
        }
      }

      if (classification.shouldAttemptCliFallback && allowCliFallback) {
        try {
          return await fetchClaudeUsageViaCli({
            authPreparation: options?.authPreparation,
            oauthCredentials,
            attempts,
            networkProxySettings: options?.networkProxySettings,
            signal: options?.signal
          })
        } catch (ptyError) {
          warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, ptyError)
        }
      }

      return errorResultForClassification({
        error: err,
        classification,
        attempts,
        oauthCredentials,
        authPreparation: options?.authPreparation
      })
    }
  }

  const credentialClassification = classifyClaudeCredentialAbsence({
    hasRefreshableCredentials: oauthCredentials.hasRefreshableCredentials,
    keychainUnavailable: oauthCredentials.keychainUnavailable,
    managedRefreshDeferredByLivePty: options?.authPreparation?.managedRefreshDeferredByLivePty
  })

  if (shouldDeferForLiveClaude(options?.authPreparation, credentialClassification)) {
    return liveClaudeDeferredResult({
      attempts,
      oauthCredentials,
      authPreparation: options?.authPreparation
    })
  }

  if (
    oauthCredentials.hasRefreshableCredentials &&
    credentialClassification.shouldAttemptDelegatedRefresh &&
    allowCliFallback
  ) {
    const repaired = await attemptCliRepairThenRetryOAuth({
      options,
      attempts,
      oauthCredentials
    })
    if (repaired) {
      return repaired
    }
  }

  if (
    (oauthCredentials.token ||
      oauthCredentials.hasRefreshableCredentials ||
      oauthCredentials.keychainUnavailable) &&
    credentialClassification.shouldAttemptCliFallback &&
    allowCliFallback
  ) {
    try {
      return await fetchClaudeUsageViaCli({
        authPreparation: options?.authPreparation,
        oauthCredentials,
        attempts,
        networkProxySettings: options?.networkProxySettings,
        signal: options?.signal
      })
    } catch (err) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, err)
      return makeClaudeUsageResult('error', withMacTailscaleDnsHint(describeError(err)), {
        ...metadataForAttempt({
          attemptedSources: attempts.attemptedSources,
          oauthCredentials,
          authPreparation: options?.authPreparation,
          failureKind:
            credentialClassification.failureKind === 'keychain-unavailable'
              ? 'keychain-unavailable'
              : 'cli-unavailable'
        })
      })
    }
  }

  if (oauthCredentials.keychainUnavailable) {
    return makeClaudeUsageResult('error', 'Claude Keychain credentials unavailable', {
      ...metadataForAttempt({
        attemptedSources: attempts.attemptedSources,
        oauthCredentials,
        authPreparation: options?.authPreparation,
        failureKind: 'keychain-unavailable'
      })
    })
  }

  if (oauthCredentials.hasRefreshableCredentials) {
    return makeClaudeUsageResult('error', 'Claude OAuth access token unavailable', {
      ...metadataForAttempt({
        attemptedSources: attempts.attemptedSources,
        oauthCredentials,
        authPreparation: options?.authPreparation,
        failureKind: credentialClassification.failureKind
      })
    })
  }

  if (allowCliFallback && plan.steps.some((step) => step.source === 'cli')) {
    try {
      return await fetchClaudeUsageViaCli({
        authPreparation: options?.authPreparation,
        oauthCredentials,
        attempts,
        networkProxySettings: options?.networkProxySettings,
        signal: options?.signal
      })
    } catch (err) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, err)
    }
  }

  return makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', {
    ...metadataForAttempt({
      attemptedSources: attempts.attemptedSources,
      oauthCredentials,
      authPreparation: options?.authPreparation,
      failureKind: 'missing-credentials'
    })
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// ---------------------------------------------------------------------------
// Managed account usage (inactive accounts — fetch-on-open)
// ---------------------------------------------------------------------------

export type InactiveClaudeAccountInfo = {
  id: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

type ManagedCredentialsLocation =
  | { kind: 'keychain'; accountId: string; managedAuthPath: string }
  | { kind: 'file'; managedAuthPath: string }

// Why: resolves where an inactive account's credentials live without
// materializing them into the shared runtime location. Using
// ClaudeRuntimeAuthService would overwrite the active account's auth.
function resolveManagedCredentialsLocation(
  account: InactiveClaudeAccountInfo
): ManagedCredentialsLocation | null {
  if (account.managedAuthRuntime === 'wsl') {
    const managedAuthPath = resolveOwnedWslClaudeManagedAuthPath(account)
    return managedAuthPath ? { kind: 'file', managedAuthPath } : null
  }
  const managedAuthPath = resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
    adoptLegacyMarker: true
  })
  if (!managedAuthPath) {
    return null
  }
  // macOS stores host managed credentials in the Keychain; everything else
  // (and WSL, handled above) stores them as a file under the managed dir.
  if (process.platform === 'darwin') {
    return { kind: 'keychain', accountId: account.id, managedAuthPath }
  }
  return { kind: 'file', managedAuthPath }
}

async function readManagedCredentialsJson(
  location: ManagedCredentialsLocation
): Promise<string | null> {
  try {
    if (location.kind === 'keychain') {
      return await readManagedClaudeKeychainCredentials(location.accountId)
    }
    return readClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json')
  } catch {
    return null
  }
}

async function writeManagedCredentialsJson(
  location: ManagedCredentialsLocation,
  credentialsJson: string
): Promise<void> {
  if (location.kind === 'keychain') {
    await writeManagedClaudeKeychainCredentials(location.accountId, credentialsJson)
    return
  }
  writeClaudeManagedAuthFile(location.managedAuthPath, '.credentials.json', credentialsJson)
}

function resolveOwnedWslClaudeManagedAuthPath(account: InactiveClaudeAccountInfo): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  const wslInfo = parseWslUncPath(account.managedAuthPath)
  if (!wslInfo || (account.wslDistro && wslInfo.distro !== account.wslDistro)) {
    return null
  }
  const linuxPath = account.wslLinuxAuthPath ?? wslInfo.linuxPath
  if (
    !linuxPath.includes('/.local/share/orca/claude-accounts/') ||
    !linuxPath.endsWith(`/${account.id}/auth`)
  ) {
    return null
  }
  try {
    const markerPath = path.join(account.managedAuthPath, '.orca-managed-claude-auth')
    if (
      !existsSync(markerPath) ||
      lstatSync(markerPath).isSymbolicLink() ||
      readFileSync(markerPath, 'utf-8').trim() !== account.id
    ) {
      return null
    }
    return account.managedAuthPath
  } catch {
    return null
  }
}

function getManagedUsagePanelAuthPreparation(
  account: InactiveClaudeAccountInfo,
  location: ManagedCredentialsLocation
): ClaudeRuntimeAuthPreparation | null {
  if (process.platform === 'win32') {
    return null
  }
  if (account.managedAuthRuntime === 'wsl') {
    if (!account.wslLinuxAuthPath || !account.wslDistro) {
      return null
    }
    return {
      configDir: location.managedAuthPath,
      runtime: 'wsl',
      wslDistro: account.wslDistro,
      wslLinuxConfigDir: account.wslLinuxAuthPath,
      envPatch: { CLAUDE_CONFIG_DIR: account.wslLinuxAuthPath },
      stripAuthEnv: true,
      provenance: `managed:${account.id}:inactive-preview`
    }
  }
  return {
    configDir: location.managedAuthPath,
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: { CLAUDE_CONFIG_DIR: location.managedAuthPath },
    stripAuthEnv: true,
    provenance: `managed:${account.id}:inactive-preview`
  }
}

function windowsAgree(left: RateLimitWindow | null, right: RateLimitWindow | null): boolean {
  return Boolean(left && right && Math.abs(left.usedPercent - right.usedPercent) <= 1)
}

function canTrustManagedUsagePanelSupplement(
  oauthLimits: ProviderRateLimits,
  cliLimits: ProviderRateLimits,
  options: { requireMatchingOAuthWindow: boolean }
): boolean {
  if (!options.requireMatchingOAuthWindow) {
    return true
  }
  const sharedWindowMatches = [
    oauthLimits.session && cliLimits.session
      ? windowsAgree(oauthLimits.session, cliLimits.session)
      : null,
    oauthLimits.weekly && cliLimits.weekly
      ? windowsAgree(oauthLimits.weekly, cliLimits.weekly)
      : null
  ].filter((match): match is boolean => match !== null)
  // Why: macOS inactive previews temporarily stage managed credentials in a
  // scoped Keychain item. If an older Claude build ignores scoped Keychains,
  // matching OAuth windows prevent active-account Fable data from leaking in.
  return sharedWindowMatches.length > 0 && sharedWindowMatches.every(Boolean)
}

async function withManagedPreviewKeychainCredentials<T>(
  location: ManagedCredentialsLocation,
  credentialsJson: string,
  fn: () => Promise<T>
): Promise<T> {
  if (location.kind !== 'keychain') {
    return fn()
  }
  await writeActiveClaudeKeychainCredentials(credentialsJson, location.managedAuthPath)
  try {
    return await fn()
  } finally {
    await deleteActiveClaudeKeychainCredentialsStrict(location.managedAuthPath).catch(() => {})
  }
}

async function readStagedManagedPreviewCredentials(
  location: ManagedCredentialsLocation
): Promise<string | null> {
  if (location.kind !== 'keychain') {
    return null
  }
  try {
    return await readActiveClaudeKeychainCredentialsStrict(location.managedAuthPath)
  } catch {
    return null
  }
}

async function fetchManagedUsagePanelSupplement(input: {
  account: InactiveClaudeAccountInfo
  location: ManagedCredentialsLocation
  credentialsJson: string
  oauthLimits: ProviderRateLimits
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits | null> {
  if (input.signal?.aborted) {
    return null
  }
  const authPreparation = getManagedUsagePanelAuthPreparation(input.account, input.location)
  if (!authPreparation) {
    return null
  }
  return withManagedPreviewKeychainCredentials(input.location, input.credentialsJson, async () => {
    const cliLimits = await fetchViaPty({
      authPreparation,
      networkProxySettings: input.networkProxySettings,
      signal: input.signal
    })
    if (input.signal?.aborted) {
      return null
    }
    if (
      !canTrustManagedUsagePanelSupplement(input.oauthLimits, cliLimits, {
        requireMatchingOAuthWindow: input.location.kind === 'keychain'
      })
    ) {
      return null
    }
    const refreshedCredentials = await readStagedManagedPreviewCredentials(input.location)
    if (refreshedCredentials && refreshedCredentials !== input.credentialsJson) {
      await writeManagedCredentialsJson(input.location, refreshedCredentials)
    }
    return cliLimits
  })
}

export async function fetchManagedAccountUsage(
  account: InactiveClaudeAccountInfo,
  options: FetchManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const location = resolveManagedCredentialsLocation(account)
  let credentialsJson = location ? await readManagedCredentialsJson(location) : null
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'No credentials',
      status: 'error'
    }
  }

  // Why: own the refresh for inactive accounts (claude-swap's model) — when the
  // stored token is expiring, refresh and persist the rotated token back to
  // managed storage before fetching usage. This keeps inactive accounts'
  // single-use refresh tokens fresh so a later switch-in never materializes a
  // stale token. Persistence failure is non-fatal: we still try the fetch.
  let token = parseOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  if (isOauthTokenExpiring(credentialsJson)) {
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      try {
        await writeManagedCredentialsJson(location, refreshed)
      } catch {
        // Keep going with the refreshed token in memory even if the write
        // failed; worst case the next poll refreshes again.
      }
      credentialsJson = refreshed
      token = parseOAuthCredentialsJson(refreshed, 'credentials-file').token
    }
  }

  if (!token) {
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'No credentials',
      status: 'error'
    }
  }

  // Why: PTY fallback is intentionally omitted for inactive accounts. The PTY
  // path is used only as a supplement after OAuth succeeds, and it points
  // directly at the managed account's isolated config so selection is unchanged.
  const oauthLimits = await fetchViaOAuth(token, options.signal)
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (
    !canSupplementOAuthUsageFromCli({
      oauthLimits,
      authPreparation: undefined,
      allowUsagePanelSupplement: options.allowUsagePanelSupplement === true
    })
  ) {
    return oauthLimits
  }
  try {
    const cliLimits = await fetchManagedUsagePanelSupplement({
      account,
      location,
      credentialsJson,
      oauthLimits,
      networkProxySettings: options.networkProxySettings,
      signal: options.signal
    })
    return mergeClaudeUsageWindows(oauthLimits, cliLimits)
  } catch (err) {
    warnClaudeUsageFetchFailure(
      undefined,
      parseOAuthCredentialsJson(credentialsJson, 'credentials-file'),
      err
    )
    return oauthLimits
  }
}
