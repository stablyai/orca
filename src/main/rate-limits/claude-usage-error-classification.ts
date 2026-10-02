import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { OAuthUsageError } from './claude-oauth-usage-error'

export type ClaudeUsageErrorClassification = {
  failureKind: UsageRateLimitFailureKind
  shouldAttemptDelegatedRefresh: boolean
  terminal: boolean
}

export function classifyClaudeOAuthUsageError(error: unknown): ClaudeUsageErrorClassification {
  if (error instanceof OAuthUsageError) {
    if (error.status === 429) {
      return terminal('rate-limited')
    }
    if (error.status === 401) {
      return recoverableAuth('stale-token')
    }
    if (error.status === 403) {
      return error.message.includes('user:profile')
        ? terminal('missing-scope')
        : recoverableAuth('stale-token')
    }
    if (error.status >= 500) {
      return transientFailure('server')
    }
    return terminal('usage-unavailable')
  }

  if (error instanceof SyntaxError) {
    return transientFailure('parse')
  }

  const message = error instanceof Error ? error.message : String(error)
  if (/\babort|network|econn|enotfound|etimedout|fetch failed|dns\b/i.test(message)) {
    return transientFailure('network')
  }

  return transientFailure('unknown')
}

export function classifyClaudeCredentialAbsence(input: {
  hasRefreshableCredentials: boolean
  keychainUnavailable?: boolean
  managedRefreshDeferredByLivePty?: boolean
}): ClaudeUsageErrorClassification {
  if (input.managedRefreshDeferredByLivePty) {
    return terminal('deferred-by-live-session')
  }
  if (input.keychainUnavailable) {
    return transientFailure('keychain-unavailable')
  }
  if (input.hasRefreshableCredentials) {
    return recoverableAuth('refreshable-credentials-without-token')
  }
  return terminal('missing-credentials')
}

function recoverableAuth(failureKind: UsageRateLimitFailureKind): ClaudeUsageErrorClassification {
  return {
    failureKind,
    shouldAttemptDelegatedRefresh: true,
    terminal: false
  }
}

function transientFailure(failureKind: UsageRateLimitFailureKind): ClaudeUsageErrorClassification {
  return {
    failureKind,
    shouldAttemptDelegatedRefresh: false,
    terminal: false
  }
}

function terminal(failureKind: UsageRateLimitFailureKind): ClaudeUsageErrorClassification {
  return {
    failureKind,
    shouldAttemptDelegatedRefresh: false,
    terminal: true
  }
}
