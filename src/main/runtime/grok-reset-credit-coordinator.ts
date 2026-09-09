import type { GrokRateLimitResetOutcome } from '../../shared/rate-limit-types'
import type { Store } from '../persistence'
import { GrokResetCreditLedger } from '../rate-limits/grok-reset-credit-ledger'
import type {
  GrokRateLimitResetRpcResult,
  RuntimeAccountServices
} from './runtime-account-controller'

export class GrokResetCreditCoordinator {
  private ledger: GrokResetCreditLedger | null = null
  private promiseByKey = new Map<string, Promise<GrokRateLimitResetRpcResult>>()
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly getServices: () => RuntimeAccountServices,
    private readonly getStore: () => Store | null
  ) {}

  consume(idempotencyKey: string): Promise<GrokRateLimitResetRpcResult> {
    const ledger = this.requireLedger()
    if (ledger.error) {
      return Promise.reject(ledger.error)
    }
    const existing = ledger.get(idempotencyKey)
    if (existing?.state === 'settled') {
      return Promise.resolve(this.result(existing.outcome))
    }
    const tracked = this.promiseByKey.get(idempotencyKey)
    if (tracked) {
      return tracked
    }
    const promise = this.serialize(() => this.consumeKey(idempotencyKey, ledger))
    this.promiseByKey.set(idempotencyKey, promise)
    const clearTrackedPromise = (): void => {
      if (this.promiseByKey.get(idempotencyKey) === promise) {
        this.promiseByKey.delete(idempotencyKey)
      }
    }
    void promise.then(clearTrackedPromise, clearTrackedPromise)
    return promise
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.mutationQueue.then(operation, operation)
    this.mutationQueue = promise.then(
      () => undefined,
      () => undefined
    )
    return promise
  }

  private async consumeKey(
    idempotencyKey: string,
    ledger: GrokResetCreditLedger
  ): Promise<GrokRateLimitResetRpcResult> {
    const existing = ledger.get(idempotencyKey)
    if (existing?.state === 'settled') {
      return this.result(existing.outcome)
    }
    if (existing?.state === 'providerPending') {
      return this.reconcilePending(idempotencyKey, ledger)
    }
    ledger.markProviderPending(
      idempotencyKey,
      this.getServices().rateLimits.getState().grok?.weekly ?? null
    )
    const result = await this.consumeOnce()
    if (result.outcome === 'usageUnavailable') {
      // Why: no provider call started, so a later natural window reset must not look like recovered redemption.
      ledger.discardProviderPending(idempotencyKey)
    } else {
      ledger.markSettled(idempotencyKey, result.outcome)
    }
    return result
  }

  private async consumeOnce(): Promise<GrokRateLimitResetRpcResult> {
    const { outcome } = await this.getServices().rateLimits.consumeGrokRateLimitResetCredit()
    return this.result(outcome)
  }

  private async reconcilePending(
    idempotencyKey: string,
    ledger: GrokResetCreditLedger
  ): Promise<GrokRateLimitResetRpcResult> {
    const { rateLimits } = this.getServices()
    const pending = ledger.get(idempotencyKey)
    await rateLimits.refreshGrok()
    const grok = rateLimits.getState().grok
    const preOperationWeekly =
      pending?.state === 'providerPending' ? pending.preOperationWeekly : undefined
    const resetCompleted =
      grok?.status === 'ok' &&
      preOperationWeekly != null &&
      preOperationWeekly.usedPercent > 0 &&
      grok.weekly != null &&
      grok.weekly.usedPercent <= 0
    if (resetCompleted) {
      ledger.markSettled(idempotencyKey, 'reset')
      return this.result('reset')
    }
    const result = await this.consumeOnce()
    if (result.outcome === 'usageUnavailable') {
      return result
    }
    if (result.outcome === 'nothingToReset' && result.snapshot.rateLimits.grok?.status !== 'ok') {
      throw new Error('The Grok reset outcome is unknown; retry the same request.')
    }
    ledger.markSettled(idempotencyKey, result.outcome)
    return result
  }

  private result(outcome: GrokRateLimitResetOutcome): GrokRateLimitResetRpcResult {
    const { claudeAccounts, codexAccounts, rateLimits } = this.getServices()
    return {
      outcome,
      snapshot: {
        claude: claudeAccounts.listAccounts(),
        codex: codexAccounts.listAccounts(),
        rateLimits: rateLimits.getState()
      }
    }
  }

  private requireLedger(): GrokResetCreditLedger {
    if (!this.ledger) {
      const store = this.getStore()
      if (!store) {
        throw new Error('Grok reset-credit persistence is unavailable')
      }
      this.ledger = new GrokResetCreditLedger(store)
    }
    return this.ledger
  }
}
