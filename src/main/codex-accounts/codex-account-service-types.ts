import type {
  CodexManagedAccount,
  CodexRateLimitAccountsState,
  CodexManagedAccountSummary
} from '../../shared/managed-account-types'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type { CodexRateLimitResetOutcome, RateLimitState } from '../../shared/rate-limit-types'

export type CodexAccountAddTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

export type CodexAccountReauthenticateOptions = {
  /** Local-only: activate after sign-in if this runtime had no selection before login. */
  activateIfSelectionWasEmpty?: boolean
}

export type CodexAccountServiceLifecycle = {
  onHostSystemDefaultSelected?: () => void
}

export type ManagedCodexHomeLocation = {
  managedHomePath: string
  managedHomeRuntime: 'host' | 'wsl'
  wslDistro: string | null
  wslLinuxHomePath: string | null
}

export type CodexResetCreditRejectedBeforeProviderReason =
  | 'targetChanged'
  | 'accountChanged'
  | 'accountRevisionChanged'
  | 'accountRuntimeChanged'
  | 'offerUnavailable'
  | 'offerChanged'

export type CodexResetCreditConsumedResult = {
  outcome: CodexRateLimitResetOutcome
  scope: CodexResetCreditExpectedScope
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexResetCreditRejectedBeforeProviderResult = {
  status: 'rejectedBeforeProvider'
  retryDisposition: 'discardAttempt'
  reason: CodexResetCreditRejectedBeforeProviderReason
  scope: CodexResetCreditExpectedScope
  codex: CodexRateLimitAccountsState
  rateLimits: RateLimitState
}

export type CodexResetCreditConsumeResult =
  | CodexResetCreditConsumedResult
  | CodexResetCreditRejectedBeforeProviderResult

export function toCodexManagedAccountSummary(
  account: CodexManagedAccount
): CodexManagedAccountSummary {
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
