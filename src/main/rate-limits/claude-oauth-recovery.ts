import { realpathSync, statSync } from 'node:fs'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { resolveClaudeCommand } from '../codex-cli/command'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { refreshClaudeLoginViaCli } from './claude-cli-login-refresh'
import {
  readClaudeCredentialsFromStrictKeychain,
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions,
  type ClaudeOAuthCredentialReadResult
} from './claude-oauth-credentials'
import { OAuthUsageError } from './claude-oauth-usage-error'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import type { ClaudeUsageErrorClassification } from './claude-usage-error-classification'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  claudeOAuthUsageSuccess,
  isManagedClaudeAuth,
  makeClaudeUsageResult,
  metadataForClaudeUsageAttempt,
  recordClaudeUsageAttempt,
  type ClaudeUsageAttemptState,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

const LIVE_REFRESH_DEFERRED_MESSAGE =
  'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'

export function canRetryClaudeOAuthWithLegacyKeychain(input: {
  classification: ClaudeUsageErrorClassification
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): boolean {
  return (
    input.classification.failureKind === 'stale-token' &&
    input.oauthCredentials.source === 'scoped-keychain' &&
    (input.authPreparation?.runtime ?? 'host') === 'host' &&
    !isManagedClaudeAuth(input.authPreparation)
  )
}

export async function retryClaudeOAuthWithLegacyKeychain(input: {
  failedToken: string | null
  attempts: ClaudeUsageAttemptState
  options?: ClaudeRateLimitFetchOptions
}): Promise<ProviderRateLimits | null> {
  const legacy = await readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
  if (!legacy.token || legacy.token === input.failedToken) {
    return null
  }
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  try {
    const limits = await fetchClaudeOAuthUsage(legacy.token, input.options?.signal)
    if (input.options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    return claudeOAuthUsageSuccess({
      limits,
      oauthCredentials: legacy,
      attempts: input.attempts,
      authPreparation: input.options?.authPreparation
    })
  } catch (error) {
    warnClaudeUsageFetchFailure(input.options?.authPreparation, legacy, error)
    return null
  }
}

export function shouldDeferClaudeUsageForLiveSession(
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

export function makeLiveClaudeUsageDeferredResult(input: {
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  return makeClaudeUsageResult('error', LIVE_REFRESH_DEFERRED_MESSAGE, {
    ...metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: 'deferred-by-live-session',
      deferredByLiveClaudeSession: true
    })
  })
}

export function makeClaudeUsageClassificationError(input: {
  error: unknown
  classification: ClaudeUsageErrorClassification
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error || 'Unknown error')
  const retryAfterMs = input.error instanceof OAuthUsageError ? input.error.retryAfterMs : null
  return makeClaudeUsageResult('error', withMacTailscaleDnsHint(message), {
    ...metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: input.classification.failureKind,
      retryAtMs: retryAfterMs ? Date.now() + retryAfterMs : undefined
    })
  })
}

// Every latch dies on its own: a login that failed to refresh is skipped until its stored
// credentials change or the backoff ends (a dead login and a network blip look the same from
// here), a binary that could not launch until the backoff ends, and a CLI without get_usage
// until the installed binary changes.
const FAILED_LOGIN_REFRESH_BACKOFF_MS = 15 * 60_000
const failedLoginRefreshByProvenance = new Map<string, { state: string; retryAtMs: number }>()
const unlaunchableCliBinaryRetryAtMs = new Map<string, number>()
const unsupportedCliBinaries = new Set<string>()

function credentialStateKey(credentials: ClaudeOAuthCredentialReadResult): string {
  return `${credentials.source}:${credentials.token ?? ''}:${credentials.hasRefreshableCredentials}`
}

function claudeBinaryKey(command: string): string {
  try {
    const real = realpathSync(command)
    return `${real}:${statSync(real).mtimeMs}`
  } catch {
    return command
  }
}

/** Test seam: the latches are process-wide. */
export function resetClaudeLoginRefreshLatchesForTests(): void {
  failedLoginRefreshByProvenance.clear()
  unlaunchableCliBinaryRetryAtMs.clear()
  unsupportedCliBinaries.clear()
}

export type ClaudeLoginRepair =
  | { kind: 'result'; result: ProviderRateLimits }
  /** Claude had its chance at this login, now or within the backoff, and it is still expired. */
  | { kind: 'not-renewed' }
  /** Nothing was learned about the login; report the original failure. */
  | { kind: 'unresolved' }
  /** Claude could not be launched, so the login's state is unknown. */
  | { kind: 'cli-unavailable' }

/**
 * Lets the account's own Claude CLI refresh its expired login, then retries the usage endpoint
 * with whatever it saved.
 */
export async function repairClaudeCredentialsThenRetryOAuth(input: {
  options?: ClaudeRateLimitFetchOptions
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
}): Promise<ClaudeLoginRepair> {
  const authPreparation = input.options?.authPreparation
  const permit = input.options?.cliLoginRefresh
  if (input.options?.signal?.aborted) {
    return { kind: 'result', result: abortedClaudeRateLimitResult() }
  }
  if (!authPreparation || !permit) {
    return { kind: 'unresolved' }
  }
  const before = credentialStateKey(input.oauthCredentials)
  const failed = failedLoginRefreshByProvenance.get(authPreparation.provenance)
  if (failed?.state === before && Date.now() < failed.retryAtMs) {
    return { kind: 'not-renewed' }
  }
  const command = resolveClaudeCommand()
  const binary = claudeBinaryKey(command)
  if (unsupportedCliBinaries.has(binary)) {
    return { kind: 'not-renewed' }
  }
  if (Date.now() < (unlaunchableCliBinaryRetryAtMs.get(binary) ?? 0)) {
    return { kind: 'cli-unavailable' }
  }
  recordClaudeUsageAttempt(input.attempts, 'cli')
  const outcome = await refreshClaudeLoginViaCli({
    authPreparation,
    readCurrentAuthProvenance: permit.readCurrentAuthProvenance,
    networkProxySettings: input.options?.networkProxySettings,
    signal: input.options?.signal,
    resolveCommand: () => command
  })
  if (outcome.kind !== 'answered') {
    warnClaudeUsageFetchFailure(
      authPreparation,
      input.oauthCredentials,
      new Error(`Claude CLI login refresh ${outcome.kind}: ${outcome.message}`)
    )
  }
  if (input.options?.signal?.aborted) {
    return { kind: 'result', result: abortedClaudeRateLimitResult() }
  }
  if (outcome.kind === 'not-started') {
    // Claude never ran, so there is nothing to re-read and no reason to back off.
    return { kind: 'unresolved' }
  }
  if (outcome.kind === 'not-launched') {
    // Backs off so a missing binary is not spawned on every poll.
    unlaunchableCliBinaryRetryAtMs.set(binary, Date.now() + FAILED_LOGIN_REFRESH_BACKOFF_MS)
    return { kind: 'cli-unavailable' }
  }
  if (outcome.kind === 'unsupported') {
    unsupportedCliBinaries.add(binary)
    return { kind: 'not-renewed' }
  }

  const refreshed = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(authPreparation)
  )
  if (input.options?.signal?.aborted) {
    return { kind: 'result', result: abortedClaudeRateLimitResult() }
  }
  if (credentialStateKey(refreshed) === before) {
    // Claude ran and saved nothing new; asking again before the login changes would fail the same way.
    failedLoginRefreshByProvenance.set(authPreparation.provenance, {
      state: before,
      retryAtMs: Date.now() + FAILED_LOGIN_REFRESH_BACKOFF_MS
    })
    return { kind: 'not-renewed' }
  }
  failedLoginRefreshByProvenance.delete(authPreparation.provenance)
  if (!refreshed.token) {
    return { kind: 'unresolved' }
  }
  recordClaudeUsageAttempt(input.attempts, 'oauth')
  try {
    const limits = await fetchClaudeOAuthUsage(refreshed.token, input.options?.signal)
    if (input.options?.signal?.aborted) {
      return { kind: 'result', result: abortedClaudeRateLimitResult() }
    }
    return {
      kind: 'result',
      result: claudeOAuthUsageSuccess({
        limits,
        oauthCredentials: refreshed,
        attempts: input.attempts,
        authPreparation
      })
    }
  } catch (error) {
    warnClaudeUsageFetchFailure(authPreparation, refreshed, error)
    return { kind: 'unresolved' }
  }
}

/**
 * After Claude failed to renew the login, only the user can: by running Claude on the account
 * (it renews or asks them to sign in) or re-authenticating it. A Claude that never launched
 * says nothing about the login, so that is reported as Claude being unavailable instead.
 */
export function failureKindAfterClaudeLoginRepair(
  repair: ClaudeLoginRepair,
  failureKind: UsageRateLimitFailureKind
): UsageRateLimitFailureKind {
  if (repair.kind === 'not-renewed') {
    return 'delegated-refresh-required'
  }
  return repair.kind === 'cli-unavailable' ? 'cli-unavailable' : failureKind
}
