import { randomUUID } from 'node:crypto'
import type {
  CodexManagedAccount,
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import {
  buildCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../shared/codex-reset-credit-scope'
import type {
  CodexRateLimitResetResult,
  RateLimitState,
  RateLimitRuntimeTarget
} from '../../shared/rate-limit-types'
import type { Store } from '../persistence'
import type { RateLimitService } from '../rate-limits/service'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import { getSelectedCodexAccountIdForTarget } from './runtime-selection'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership'
import type {
  CodexResetCreditConsumeResult,
  CodexResetCreditConsumedResult
} from './codex-account-service-types'
import type { CodexManagedHomePath } from './codex-managed-home-path'
import {
  CodexResetCreditLedger,
  resetAccountScopeKey,
  resetScopeKey,
  type CodexResetCreditAttempt
} from './codex-reset-credit-ledger'
import {
  CodexResetCreditScopeRejection,
  validateCodexResetCreditScope,
  type CodexResetCreditScopeValidation
} from './codex-reset-credit-scope-validation'

function sameTarget(left: RateLimitRuntimeTarget, right: RateLimitRuntimeTarget): boolean {
  return left.runtime === right.runtime && left.wslDistro === right.wslDistro
}

type CodexResetCreditCoordinatorDependencies = {
  store: Store
  rateLimits: RateLimitService
  runtimeHome: CodexRuntimeHomeService
  managedHomePaths: CodexManagedHomePath
  serializeMutation: <T>(operation: () => Promise<T>) => Promise<T>
  getSnapshot: () => CodexRateLimitAccountsState
  toSummary: (account: CodexManagedAccount) => CodexManagedAccountSummary
}

export class CodexResetCreditCoordinator {
  private readonly ledger: CodexResetCreditLedger

  constructor(private readonly dependencies: CodexResetCreditCoordinatorDependencies) {
    this.ledger = new CodexResetCreditLedger(dependencies.store)
  }

  consume(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): Promise<CodexResetCreditConsumeResult> {
    if (this.ledger.error) {
      return Promise.reject(this.ledger.error)
    }
    const scopeKey = resetScopeKey(expectedScope)
    const accountScopeKey = resetAccountScopeKey(expectedScope)
    const existing = this.ledger.get(idempotencyKey)
    if (existing) {
      if (existing.scopeKey !== scopeKey) {
        return Promise.reject(new Error('That idempotency key belongs to a different reset scope.'))
      }
      if (existing.state === 'settled' && existing.settledOutcome) {
        return this.dependencies.serializeMutation(async () => {
          const { rateLimits } = this.validateScope(expectedScope, { kind: 'settledReplay' })
          return {
            outcome: existing.settledOutcome!,
            scope: existing.expectedScope,
            codex: this.dependencies.getSnapshot(),
            rateLimits
          }
        })
      }
      if (existing.promise) {
        return existing.promise as Promise<CodexResetCreditConsumeResult>
      }
      return this.startAttempt(idempotencyKey, expectedScope, existing)
    }

    const unresolvedKey = this.ledger.getUnresolvedKey(accountScopeKey)
    if (unresolvedKey && unresolvedKey !== idempotencyKey) {
      return Promise.reject(
        new Error('A previous reset attempt for this account still has an unknown outcome.')
      )
    }
    const claimedKey = this.ledger.getClaimedKey(scopeKey)
    if (claimedKey && claimedKey !== idempotencyKey) {
      return Promise.reject(new Error('That reset-credit offer was already attempted.'))
    }
    return this.startAttempt(
      idempotencyKey,
      expectedScope,
      this.ledger.createFresh(idempotencyKey, expectedScope)
    )
  }

  async consumeCurrent(): Promise<CodexRateLimitResetResult> {
    if (this.ledger.error) {
      throw this.ledger.error
    }
    const initialRateLimits = this.dependencies.rateLimits.getState()
    const initialTarget = { ...initialRateLimits.codexTarget }
    const initialSettings = this.dependencies.store.getSettings()
    const selectedAccountId = getSelectedCodexAccountIdForTarget(initialSettings, initialTarget)
    if (selectedAccountId) {
      const account = initialSettings.codexManagedAccounts.find(
        (candidate) => candidate.id === selectedAccountId
      )
      const pendingAttempt = account
        ? this.ledger.getPendingForAccount(initialTarget, account)
        : null
      const expectedScope =
        pendingAttempt?.expectedScope ??
        (account
          ? buildCodexResetCreditExpectedScope({
              target: initialTarget,
              account: this.dependencies.toSummary(account),
              limits: initialRateLimits.codex
            })
          : null)
      if (!expectedScope) {
        throw new Error('The managed Codex reset-credit offer is no longer available.')
      }
      // Why: do not enter the mutation queue first; the coordinator owns that
      // queue and nested serialization would deadlock behind this operation.
      const result = await this.consume(
        pendingAttempt?.idempotencyKey ?? randomUUID(),
        expectedScope
      )
      if ('status' in result) {
        throw new Error('The Codex account or reset offer changed before reset.')
      }
      return { outcome: result.outcome, state: result.rateLimits }
    }

    return this.dependencies.serializeMutation(async () => {
      if (this.ledger.error) {
        throw this.ledger.error
      }
      const target = this.dependencies.rateLimits.getState().codexTarget
      if (!sameTarget(target, initialTarget)) {
        throw new Error('The active Codex rate-limit target changed before reset.')
      }
      if (getSelectedCodexAccountIdForTarget(this.dependencies.store.getSettings(), target)) {
        throw new Error('The selected Codex account changed before reset.')
      }
      if (this.ledger.hasPendingForTarget(target)) {
        throw new Error('A previous reset attempt for this target still has an unknown outcome.')
      }
      const homeResolution = this.dependencies.runtimeHome.prepareForRateLimitFetch(target)
      // Why: reject before the provider mutation — a skip must never be spent
      // against the system-default home (#STA-4422).
      if (homeResolution.kind === 'skip') {
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
      return this.dependencies.rateLimits.consumeCodexRateLimitResetCredit({
        idempotencyKey: randomUUID(),
        target,
        codexHomePath: homeResolution.codexHomePath
      })
    })
  }

  discardForRemovedAccount(accountId: string): void {
    this.ledger.discardForRemovedAccount(accountId)
  }

  private startAttempt(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope,
    attempt: CodexResetCreditAttempt
  ): Promise<CodexResetCreditConsumeResult> {
    const promise = this.dependencies.serializeMutation(
      async (): Promise<CodexResetCreditConsumeResult> => {
        const isFresh = attempt.state === 'fresh'
        let validation: { managedHomePath: string; rateLimits: RateLimitState }
        try {
          validation = this.validateScope(expectedScope, {
            kind: 'providerMutation',
            requireCurrentOffer: isFresh
          })
        } catch (error) {
          if (isFresh && error instanceof CodexResetCreditScopeRejection) {
            this.ledger.releaseFresh(idempotencyKey, attempt)
            return {
              status: 'rejectedBeforeProvider',
              retryDisposition: 'discardAttempt',
              reason: error.reason,
              scope: expectedScope,
              codex: this.dependencies.getSnapshot(),
              rateLimits: error.rateLimits
            }
          }
          throw error
        }
        if (isFresh) {
          this.ledger.markProviderPending(idempotencyKey, attempt)
        }
        const { outcome, state } =
          await this.dependencies.rateLimits.consumeCodexRateLimitResetCredit({
            idempotencyKey,
            target: expectedScope.target,
            codexHomePath: validation.managedHomePath
          })
        // Why: queued account selection may start as soon as this mutation resolves;
        // capture both account selection and usage before releasing the queue.
        const result: CodexResetCreditConsumedResult = {
          outcome,
          scope: expectedScope,
          codex: this.dependencies.getSnapshot(),
          rateLimits: state
        }
        this.ledger.markSettled(idempotencyKey, attempt, outcome)
        return result
      }
    )
    attempt.promise = promise
    void promise.then(
      () => {
        attempt.promise = null
      },
      () => {
        attempt.promise = null
        if (attempt.state === 'fresh') {
          this.ledger.releaseFresh(idempotencyKey, attempt)
        }
      }
    )
    return promise
  }

  private validateScope(
    expectedScope: CodexResetCreditExpectedScope,
    validation: CodexResetCreditScopeValidation
  ): { managedHomePath: string; rateLimits: RateLimitState } {
    return validateCodexResetCreditScope(expectedScope, validation, this.dependencies)
  }
}
