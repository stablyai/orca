import type { CodexRateLimitResetOutcome, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS,
  type DurableGrokResetCreditAttempt,
  type GrokResetCreditAttemptLedger
} from '../../shared/grok-reset-credit-attempt-ledger'
import type { Store } from '../persistence'

export class GrokResetCreditLedger {
  private attemptsByKey = new Map<string, DurableGrokResetCreditAttempt>()
  private durableLedger: GrokResetCreditAttemptLedger | null = null
  private loadError: Error | null = null

  constructor(private readonly store: Store) {
    this.hydrate()
  }

  get error(): Error | null {
    return this.loadError
  }

  get(idempotencyKey: string): DurableGrokResetCreditAttempt | undefined {
    return this.attemptsByKey.get(idempotencyKey)
  }

  markProviderPending(idempotencyKey: string, preOperationWeekly: RateLimitWindow | null): void {
    const attempt = { idempotencyKey, state: 'providerPending', preOperationWeekly } as const
    this.persist(attempt)
    this.attemptsByKey.set(idempotencyKey, attempt)
  }

  markSettled(idempotencyKey: string, outcome: CodexRateLimitResetOutcome): void {
    const attempt = { idempotencyKey, state: 'settled', outcome } as const
    this.persist(attempt)
    this.attemptsByKey.set(idempotencyKey, attempt)
  }

  discardProviderPending(idempotencyKey: string): void {
    if (this.attemptsByKey.get(idempotencyKey)?.state !== 'providerPending') {
      return
    }
    if (!this.durableLedger) {
      throw this.loadError ?? new Error('Grok reset-credit attempt ledger is unavailable')
    }
    const attempts = this.durableLedger.attempts.filter(
      (attempt) => attempt.idempotencyKey !== idempotencyKey
    )
    const nextLedger: GrokResetCreditAttemptLedger = { version: 1, attempts }
    this.store.replaceGrokResetCreditAttemptLedgerAndFlush(nextLedger)
    this.durableLedger = structuredClone(nextLedger)
    this.attemptsByKey.delete(idempotencyKey)
  }

  private hydrate(): void {
    try {
      this.durableLedger = this.store.getGrokResetCreditAttemptLedger()
      this.attemptsByKey = new Map(
        this.durableLedger.attempts.map((attempt) => [attempt.idempotencyKey, attempt])
      )
    } catch (error) {
      this.loadError =
        error instanceof Error ? error : new Error('Grok reset-credit attempt ledger is corrupt')
    }
  }

  private persist(nextAttempt: DurableGrokResetCreditAttempt): void {
    if (!this.durableLedger) {
      throw this.loadError ?? new Error('Grok reset-credit attempt ledger is unavailable')
    }
    const existing = this.durableLedger.attempts.filter(
      (attempt) => attempt.idempotencyKey !== nextAttempt.idempotencyKey
    )
    const pending = existing.filter((attempt) => attempt.state === 'providerPending')
    const settled = existing.filter((attempt) => attempt.state === 'settled')
    if (nextAttempt.state === 'settled') {
      settled.push(nextAttempt)
    } else {
      pending.push(nextAttempt)
    }
    const attempts = [...pending, ...settled.slice(-MAX_SETTLED_GROK_RESET_CREDIT_ATTEMPTS)]
    const nextLedger: GrokResetCreditAttemptLedger = { version: 1, attempts }
    this.store.replaceGrokResetCreditAttemptLedgerAndFlush(nextLedger)
    this.durableLedger = structuredClone(nextLedger)
    this.attemptsByKey = new Map(attempts.map((attempt) => [attempt.idempotencyKey, attempt]))
  }
}
