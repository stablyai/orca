import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type {
  CodexResetCreditAttemptLedger,
  DurableCodexResetCreditAttempt
} from '../../shared/codex-reset-credit-attempt-ledger'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import type {
  CodexRateLimitResetOutcome,
  RateLimitRuntimeTarget
} from '../../shared/rate-limit-types'
import type { Store } from '../persistence'

export type CodexResetCreditAttempt = {
  expectedScope: CodexResetCreditExpectedScope
  scopeKey: string
  accountScopeKey: string
  state: 'fresh' | 'providerPending' | 'settled'
  promise: Promise<unknown> | null
  settledOutcome: CodexRateLimitResetOutcome | null
}

export function resetScopeKey(scope: CodexResetCreditExpectedScope): string {
  return JSON.stringify([
    scope.target.runtime,
    scope.target.wslDistro,
    scope.accountId,
    scope.accountRevision,
    scope.offerRevision
  ])
}

export function resetAccountScopeKey(
  scope: Pick<CodexResetCreditExpectedScope, 'target' | 'accountId' | 'accountRevision'>
): string {
  return JSON.stringify([
    scope.target.runtime,
    scope.target.wslDistro,
    scope.accountId,
    scope.accountRevision
  ])
}

export class CodexResetCreditLedger {
  private readonly attemptsByKey = new Map<string, CodexResetCreditAttempt>()
  private readonly attemptKeyByOffer = new Map<string, string>()
  private readonly unresolvedKeyByAccountScope = new Map<string, string>()
  private durableLedger: CodexResetCreditAttemptLedger | null = null
  private loadError: Error | null = null

  constructor(private readonly store: Store) {
    this.hydrate()
  }

  get error(): Error | null {
    return this.loadError
  }

  get(idempotencyKey: string): CodexResetCreditAttempt | undefined {
    return this.attemptsByKey.get(idempotencyKey)
  }

  getUnresolvedKey(accountScopeKey: string): string | undefined {
    return this.unresolvedKeyByAccountScope.get(accountScopeKey)
  }

  getClaimedKey(scopeKey: string): string | undefined {
    return this.attemptKeyByOffer.get(scopeKey)
  }

  createFresh(
    idempotencyKey: string,
    expectedScope: CodexResetCreditExpectedScope
  ): CodexResetCreditAttempt {
    const attempt: CodexResetCreditAttempt = {
      expectedScope,
      scopeKey: resetScopeKey(expectedScope),
      accountScopeKey: resetAccountScopeKey(expectedScope),
      state: 'fresh',
      promise: null,
      settledOutcome: null
    }
    this.attemptsByKey.set(idempotencyKey, attempt)
    this.attemptKeyByOffer.set(attempt.scopeKey, idempotencyKey)
    return attempt
  }

  getPendingForAccount(
    target: RateLimitRuntimeTarget,
    account: CodexManagedAccount
  ): { idempotencyKey: string; expectedScope: CodexResetCreditExpectedScope } | null {
    const accountScopeKey = resetAccountScopeKey({
      target,
      accountId: account.id,
      accountRevision: account.updatedAt
    })
    const idempotencyKey = this.unresolvedKeyByAccountScope.get(accountScopeKey)
    if (!idempotencyKey) {
      return null
    }
    const attempt = this.attemptsByKey.get(idempotencyKey)
    if (attempt?.state !== 'providerPending') {
      throw new Error('Codex reset-credit attempt state is inconsistent.')
    }
    // Why: a durable providerPending attempt can only be resolved with its original key.
    return { idempotencyKey, expectedScope: attempt.expectedScope }
  }

  hasPendingForTarget(target: RateLimitRuntimeTarget): boolean {
    return [...this.attemptsByKey.values()].some(
      (attempt) =>
        attempt.state === 'providerPending' &&
        attempt.expectedScope.target.runtime === target.runtime &&
        attempt.expectedScope.target.wslDistro === target.wslDistro
    )
  }

  markProviderPending(idempotencyKey: string, attempt: CodexResetCreditAttempt): void {
    this.persist({ idempotencyKey, expectedScope: attempt.expectedScope, state: 'providerPending' })
    attempt.state = 'providerPending'
    this.unresolvedKeyByAccountScope.set(attempt.accountScopeKey, idempotencyKey)
  }

  markSettled(
    idempotencyKey: string,
    attempt: CodexResetCreditAttempt,
    outcome: CodexRateLimitResetOutcome
  ): void {
    this.persist({
      idempotencyKey,
      expectedScope: attempt.expectedScope,
      state: 'settled',
      outcome
    })
    attempt.state = 'settled'
    attempt.settledOutcome = outcome
    if (this.unresolvedKeyByAccountScope.get(attempt.accountScopeKey) === idempotencyKey) {
      this.unresolvedKeyByAccountScope.delete(attempt.accountScopeKey)
    }
  }

  releaseFresh(idempotencyKey: string, attempt: CodexResetCreditAttempt): void {
    if (attempt.state !== 'fresh') {
      return
    }
    this.attemptsByKey.delete(idempotencyKey)
    if (this.attemptKeyByOffer.get(attempt.scopeKey) === idempotencyKey) {
      this.attemptKeyByOffer.delete(attempt.scopeKey)
    }
  }

  // Why: a removed account's managed home is gone, so its unresolved providerPending
  // attempt can never validate or be replayed; drop it so a target-scoped default reset
  // is not wedged forever by hasPendingResetForTarget matching the orphan.
  discardForRemovedAccount(accountId: string): void {
    const staleAttempts = [...this.attemptsByKey].filter(
      ([, attempt]) => attempt.expectedScope.accountId === accountId
    )
    if (staleAttempts.length === 0) {
      return
    }
    const staleKeySet = new Set(staleAttempts.map(([idempotencyKey]) => idempotencyKey))
    if (this.durableLedger) {
      const attempts = this.durableLedger.attempts.filter(
        (attempt) => !staleKeySet.has(attempt.idempotencyKey)
      )
      if (attempts.length !== this.durableLedger.attempts.length) {
        const nextLedger: CodexResetCreditAttemptLedger = { version: 1, attempts }
        // Persist first so a failed durability barrier leaves the in-memory
        // fail-closed guards aligned with the ledger that will reload.
        this.store.replaceCodexResetCreditAttemptLedgerAndFlush(nextLedger)
        this.durableLedger = structuredClone(nextLedger)
      }
    }
    for (const [idempotencyKey, attempt] of staleAttempts) {
      this.attemptsByKey.delete(idempotencyKey)
      if (this.attemptKeyByOffer.get(attempt.scopeKey) === idempotencyKey) {
        this.attemptKeyByOffer.delete(attempt.scopeKey)
      }
      if (this.unresolvedKeyByAccountScope.get(attempt.accountScopeKey) === idempotencyKey) {
        this.unresolvedKeyByAccountScope.delete(attempt.accountScopeKey)
      }
    }
  }

  private hydrate(): void {
    try {
      const ledger = this.store.getCodexResetCreditAttemptLedger()
      this.durableLedger = ledger
      for (const durable of ledger.attempts) {
        const attempt: CodexResetCreditAttempt = {
          expectedScope: durable.expectedScope,
          scopeKey: resetScopeKey(durable.expectedScope),
          accountScopeKey: resetAccountScopeKey(durable.expectedScope),
          state: durable.state,
          promise: null,
          settledOutcome: durable.state === 'settled' ? durable.outcome : null
        }
        this.attemptsByKey.set(durable.idempotencyKey, attempt)
        this.attemptKeyByOffer.set(attempt.scopeKey, durable.idempotencyKey)
        if (durable.state === 'providerPending') {
          this.unresolvedKeyByAccountScope.set(attempt.accountScopeKey, durable.idempotencyKey)
        }
      }
    } catch (error) {
      this.loadError =
        error instanceof Error ? error : new Error('Codex reset-credit attempt ledger is corrupt')
    }
  }

  private persist(nextAttempt: DurableCodexResetCreditAttempt): void {
    if (!this.durableLedger) {
      throw this.loadError ?? new Error('Codex reset-credit attempt ledger is unavailable')
    }
    const index = this.durableLedger.attempts.findIndex(
      (attempt) => attempt.idempotencyKey === nextAttempt.idempotencyKey
    )
    const attempts = [...this.durableLedger.attempts]
    if (index === -1) {
      attempts.push(nextAttempt)
    } else {
      attempts[index] = nextAttempt
    }
    const nextLedger: CodexResetCreditAttemptLedger = { version: 1, attempts }
    this.store.replaceCodexResetCreditAttemptLedgerAndFlush(nextLedger)
    this.durableLedger = structuredClone(nextLedger)
  }
}
