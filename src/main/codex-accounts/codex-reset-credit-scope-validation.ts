import type {
  CodexManagedAccount,
  CodexManagedAccountSummary
} from '../../shared/managed-account-types'
import {
  buildCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../shared/codex-reset-credit-scope'
import type { RateLimitState, RateLimitRuntimeTarget } from '../../shared/rate-limit-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexResetCreditRejectedBeforeProviderReason } from './codex-account-service-types'
import type { CodexManagedHomePath } from './codex-managed-home-path'
import { resetScopeKey } from './codex-reset-credit-ledger'
import {
  getCodexSelectionTargetForAccount,
  getSelectedCodexAccountIdForTarget,
  normalizeCodexAccountSelectionTarget
} from './runtime-selection'

export type CodexResetCreditScopeValidation =
  | { kind: 'settledReplay' }
  | { kind: 'providerMutation'; requireCurrentOffer: boolean }

export class CodexResetCreditScopeRejection extends Error {
  constructor(
    readonly reason: CodexResetCreditRejectedBeforeProviderReason,
    readonly rateLimits: RateLimitState,
    message: string
  ) {
    super(message)
    this.name = 'CodexResetCreditScopeRejection'
  }
}

type CodexResetCreditScopeDependencies = {
  store: Store
  rateLimits: RateLimitService
  managedHomePaths: CodexManagedHomePath
  toSummary: (account: CodexManagedAccount) => CodexManagedAccountSummary
}

function sameTarget(left: RateLimitRuntimeTarget, right: RateLimitRuntimeTarget): boolean {
  return left.runtime === right.runtime && left.wslDistro === right.wslDistro
}

export function validateCodexResetCreditScope(
  expectedScope: CodexResetCreditExpectedScope,
  validation: CodexResetCreditScopeValidation,
  dependencies: CodexResetCreditScopeDependencies
): { managedHomePath: string; rateLimits: RateLimitState } {
  const rateLimitState = dependencies.rateLimits.getState()
  if (!sameTarget(rateLimitState.codexTarget, expectedScope.target)) {
    throw new CodexResetCreditScopeRejection(
      'targetChanged',
      rateLimitState,
      'The active Codex rate-limit target changed before reset.'
    )
  }
  const settings = dependencies.store.getSettings()
  if (
    getSelectedCodexAccountIdForTarget(settings, expectedScope.target) !== expectedScope.accountId
  ) {
    throw new CodexResetCreditScopeRejection(
      'accountChanged',
      rateLimitState,
      'The selected Codex account changed before reset.'
    )
  }
  const account = settings.codexManagedAccounts.find(
    (candidate) => candidate.id === expectedScope.accountId
  )
  if (!account || account.updatedAt !== expectedScope.accountRevision) {
    throw new CodexResetCreditScopeRejection(
      'accountRevisionChanged',
      rateLimitState,
      'The selected Codex account was updated before reset.'
    )
  }
  const accountTarget = normalizeCodexAccountSelectionTarget(
    getCodexSelectionTargetForAccount(account)
  )
  if (!sameTarget(accountTarget, expectedScope.target)) {
    throw new CodexResetCreditScopeRejection(
      'accountRuntimeChanged',
      rateLimitState,
      'The selected Codex account belongs to a different runtime.'
    )
  }
  if (validation.kind === 'providerMutation' && validation.requireCurrentOffer) {
    const currentScope = buildCodexResetCreditExpectedScope({
      target: rateLimitState.codexTarget,
      account: dependencies.toSummary(account),
      limits: rateLimitState.codex
    })
    if (!currentScope) {
      throw new CodexResetCreditScopeRejection(
        'offerUnavailable',
        rateLimitState,
        'The Codex reset-credit offer is no longer available.'
      )
    }
    if (resetScopeKey(expectedScope) !== resetScopeKey(currentScope)) {
      throw new CodexResetCreditScopeRejection(
        'offerChanged',
        rateLimitState,
        'The Codex reset-credit offer changed before reset.'
      )
    }
  }
  if (validation.kind === 'providerMutation' && expectedScope.target.runtime === 'host') {
    dependencies.managedHomePaths.assertHostOwnership(account.managedHomePath, account.id)
  }
  return { managedHomePath: account.managedHomePath, rateLimits: rateLimitState }
}
