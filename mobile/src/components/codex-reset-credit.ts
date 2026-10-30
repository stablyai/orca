import {
  buildCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../../src/shared/codex-reset-credit-scope'
import {
  codexResetCreditConsume,
  type MobileCodexResetCreditRpcSender,
  type MobileCodexResetCreditSendScope
} from './codex-reset-credit-consume-operations'
import { CodexResetCreditExpectedScopeSchema } from './codex-reset-credit-reply-schema'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { translate } from '../i18n/mobile-i18n'
import {
  decodeAccountsSnapshot,
  type AccountsSnapshot,
  type ProviderRateLimits
} from './accounts-snapshot'

export type CodexResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export type CodexResetCreditRejectedBeforeProviderReason =
  | 'targetChanged'
  | 'accountChanged'
  | 'accountRevisionChanged'
  | 'accountRuntimeChanged'
  | 'offerUnavailable'
  | 'offerChanged'

export type CodexResetCreditConsumedRpcResult = {
  outcome: CodexResetCreditOutcome
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
}

export type CodexResetCreditRejectedRpcResult = {
  status: 'rejectedBeforeProvider'
  retryDisposition: 'discardAttempt'
  reason: CodexResetCreditRejectedBeforeProviderReason
  scope: CodexResetCreditExpectedScope
  snapshot: AccountsSnapshot
}

export type CodexResetCreditRpcResult =
  | CodexResetCreditConsumedRpcResult
  | CodexResetCreditRejectedRpcResult

export type CodexResetCreditSummary = {
  availableCount: number
  availabilityLabel: string
  expiryLabel: string | null
}

const RESET_RPC_TIMEOUT_MS = 90_000

function resetCreditExpiryLabel(ms: number, count: number): string {
  if (ms <= 0) {
    return count === 1
      ? translate('components.codexResetCredit.expiryNowSingle', 'Expires now')
      : translate('components.codexResetCredit.expiryNowMultiple', 'Next expires now')
  }
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) {
    return count === 1
      ? translate('components.codexResetCredit.expiryMinutesSingle', 'Expires in {{minutes}}m', {
          minutes: totalMinutes
        })
      : translate(
          'components.codexResetCredit.expiryMinutesMultiple',
          'Next expires in {{minutes}}m',
          { minutes: totalMinutes }
        )
  }
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) {
    const options = { hours: totalHours, minutes }
    if (minutes > 0) {
      return count === 1
        ? translate(
            'components.codexResetCredit.expiryHoursMinutesSingle',
            'Expires in {{hours}}h {{minutes}}m',
            options
          )
        : translate(
            'components.codexResetCredit.expiryHoursMinutesMultiple',
            'Next expires in {{hours}}h {{minutes}}m',
            options
          )
    }
    return count === 1
      ? translate('components.codexResetCredit.expiryHoursSingle', 'Expires in {{hours}}h', options)
      : translate(
          'components.codexResetCredit.expiryHoursMultiple',
          'Next expires in {{hours}}h',
          options
        )
  }
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  const options = { days, hours }
  if (hours > 0) {
    return count === 1
      ? translate(
          'components.codexResetCredit.expiryDaysHoursSingle',
          'Expires in {{days}}d {{hours}}h',
          options
        )
      : translate(
          'components.codexResetCredit.expiryDaysHoursMultiple',
          'Next expires in {{days}}d {{hours}}h',
          options
        )
  }
  return count === 1
    ? translate('components.codexResetCredit.expiryDaysSingle', 'Expires in {{days}}d', options)
    : translate(
        'components.codexResetCredit.expiryDaysMultiple',
        'Next expires in {{days}}d',
        options
      )
}

export function getCodexResetCreditSummary(
  limits: ProviderRateLimits | null,
  now: number
): CodexResetCreditSummary | null {
  const credits = limits?.rateLimitResetCredits
  const count = credits?.availableCount ?? 0
  if (!Number.isInteger(count) || count <= 0) {
    return null
  }
  const expiry = credits?.nextExpiresAt
  const expiryLabel =
    typeof expiry === 'number' && Number.isFinite(expiry)
      ? resetCreditExpiryLabel(expiry - now, count)
      : null
  return {
    availableCount: count,
    availabilityLabel:
      count === 1
        ? translate('components.codexResetCredit.available_one', '{{count}} reset available', {
            count
          })
        : translate('components.codexResetCredit.available_other', '{{count}} resets available', {
            count
          }),
    expiryLabel
  }
}

export function getCodexResetCreditOutcomeCopy(outcome: CodexResetCreditOutcome): {
  title: string
  message: string
} {
  switch (outcome) {
    case 'reset':
    case 'alreadyRedeemed':
      return {
        title:
          outcome === 'reset'
            ? translate('components.codexResetCredit.resetTitle', 'Rate limits reset')
            : translate('components.codexResetCredit.alreadyAppliedTitle', 'Reset already applied'),
        message: translate('components.codexResetCredit.refresh', 'Codex usage has been refreshed.')
      }
    case 'nothingToReset':
      return {
        title: translate('components.codexResetCredit.nothingToResetTitle', 'Nothing to reset'),
        message: translate(
          'components.codexResetCredit.nothingToResetMessage',
          'No eligible Codex rate-limit window is exhausted.'
        )
      }
    case 'noCredit':
      return {
        title: translate('components.codexResetCredit.noResetTitle', 'No reset available'),
        message: translate(
          'components.codexResetCredit.noResetMessage',
          'This account has no earned reset credits available.'
        )
      }
  }
}

export function getActiveCodexAccountIdForRateLimitTarget(
  snapshot: AccountsSnapshot
): string | null {
  const target = snapshot.rateLimits.codexTarget
  const selection = snapshot.codex.activeAccountIdsByRuntime
  if (!selection) {
    return null
  }
  if (target.runtime === 'host') {
    return target.wslDistro === null ? selection.host : null
  }
  const distro = target.wslDistro?.trim()
  return distro ? (selection.wsl[distro] ?? null) : null
}

export function getCodexResetCreditScope(
  snapshot: AccountsSnapshot
): CodexResetCreditExpectedScope | null {
  const activeAccountId = getActiveCodexAccountIdForRateLimitTarget(snapshot)
  const account = activeAccountId
    ? (snapshot.codex.accounts.find((candidate) => candidate.id === activeAccountId) ?? null)
    : null
  const scope = buildCodexResetCreditExpectedScope({
    target: snapshot.rateLimits.codexTarget,
    account,
    limits: snapshot.rateLimits.codex
  })
  if (!scope) {
    return null
  }
  const parsed = CodexResetCreditExpectedScopeSchema.safeParse(scope)
  return parsed.success ? parsed.data : null
}

// Match account scope, not offer: host may return unresolved retry attempt against earlier offer.
function sameAccountScope(
  left: CodexResetCreditExpectedScope,
  right: CodexResetCreditExpectedScope
): boolean {
  return (
    left.target.runtime === right.target.runtime &&
    left.target.wslDistro === right.target.wslDistro &&
    left.accountId === right.accountId &&
    left.accountRevision === right.accountRevision
  )
}

function invalidResetResponse(): Error {
  return new Error(
    translate('components.codexResetCredit.invalidResponse', 'Invalid reset response from host')
  )
}

function decodeResetResult(
  value: unknown,
  expectedScope: CodexResetCreditExpectedScope
): CodexResetCreditRpcResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResetResponse()
  }
  const result = value as Record<string, unknown>
  const scope = CodexResetCreditExpectedScopeSchema.safeParse(result.scope)
  if (!scope.success || !sameAccountScope(scope.data, expectedScope)) {
    throw invalidResetResponse()
  }
  const snapshot = decodeAccountsSnapshot(result.snapshot)
  if (result.status === 'rejectedBeforeProvider') {
    const reason = result.reason
    if (
      result.retryDisposition !== 'discardAttempt' ||
      result.outcome !== undefined ||
      (reason !== 'targetChanged' &&
        reason !== 'accountChanged' &&
        reason !== 'accountRevisionChanged' &&
        reason !== 'accountRuntimeChanged' &&
        reason !== 'offerUnavailable' &&
        reason !== 'offerChanged')
    ) {
      throw invalidResetResponse()
    }
    return {
      status: 'rejectedBeforeProvider',
      retryDisposition: 'discardAttempt',
      reason,
      scope: scope.data,
      snapshot
    }
  }
  const outcome = result.outcome
  if (
    result.status !== undefined ||
    outcome === undefined ||
    (outcome !== 'reset' &&
      outcome !== 'nothingToReset' &&
      outcome !== 'noCredit' &&
      outcome !== 'alreadyRedeemed')
  ) {
    throw invalidResetResponse()
  }
  const snapshotAccount = snapshot.codex.accounts.find(
    (account) => account.id === scope.data.accountId
  )
  if (
    snapshot.rateLimits.codexTarget.runtime !== scope.data.target.runtime ||
    snapshot.rateLimits.codexTarget.wslDistro !== scope.data.target.wslDistro ||
    getActiveCodexAccountIdForRateLimitTarget(snapshot) !== scope.data.accountId ||
    snapshotAccount?.updatedAt !== scope.data.accountRevision
  ) {
    throw invalidResetResponse()
  }
  return {
    outcome,
    scope: scope.data,
    snapshot
  }
}

// Use fresh key per attempt without phone journal; host ledger resumes same-offer/unknown-account attempts so lost replies cannot spend twice.
export async function requestCodexResetCredit(
  client: MobileCodexResetCreditRpcSender,
  expectedScope: CodexResetCreditExpectedScope
): Promise<CodexResetCreditRpcResult> {
  const scope = CodexResetCreditExpectedScopeSchema.parse(expectedScope)
  const response = await codexResetCreditConsume.request(
    client,
    {
      idempotencyKey: randomV4Uuid(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed just above through CodexResetCreditExpectedScopeSchema, whose refinement pairs runtime 'host' with a null distro and 'wsl' with a trimmed non-empty one. The bytes are unchanged.
      expectedScope: scope as MobileCodexResetCreditSendScope
    },
    { timeoutMs: RESET_RPC_TIMEOUT_MS }
  )
  return decodeResetResult(codexResetCreditConsume.interpret(response), scope)
}
