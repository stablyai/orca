import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export type MobileWebSubscriptionRecord = {
  requestId: string
  sequence: number
  active: boolean
  unsubscribe: () => void
  delivery: Promise<void>
}

export type MobileWebSubscriptionLedgerOptions<TEvent> = {
  operationKey: string
  isActive: () => boolean
  postEvent: (subscriptionId: string, sequence: number, event: TEvent) => Promise<void>
  postClosed: MobileWebPostSubscriptionClosed
}

/** The ledger surface callers share across every event and record type. */
export type MobileWebSubscriptionLedgerHandle = {
  cancel: (subscriptionId: string, closure?: MobileWebSubscriptionClosure) => string | null
  cancelByRequest: (requestId: string) => void
  countForOperation: (operationKey: string) => number
  closeAll: (closure: MobileWebSubscriptionClosure) => void
  dispose: () => void
}

/** What a concrete ledger supplies; the operation key is its own identity, not the caller's. */
export type MobileWebSubscriptionLedgerConfig<TEvent> = Omit<
  MobileWebSubscriptionLedgerOptions<TEvent>,
  'operationKey'
>

/** One shell-side subscription ledger: admission, the host handle, serialised delivery, and
 *  retirement. Subclasses own only their host `subscribe` call and their event projection. */
export class MobileWebSubscriptionLedger<
  TEvent,
  TRecord extends MobileWebSubscriptionRecord = MobileWebSubscriptionRecord
> {
  protected readonly records = new Map<string, TRecord>()

  constructor(protected readonly options: MobileWebSubscriptionLedgerOptions<TEvent>) {}

  cancel(subscriptionId: string, closure?: MobileWebSubscriptionClosure): string | null {
    const record = this.records.get(subscriptionId)
    if (!record) {
      return null
    }
    record.active = false
    this.records.delete(subscriptionId)
    this.retire(record)
    try {
      record.unsubscribe()
    } catch {
      // The page authority is retired even when host subscription cleanup fails.
    }
    if (closure) {
      this.options.postClosed(subscriptionId, closure)
    }
    return record.requestId
  }

  cancelByRequest(requestId: string): void {
    for (const [subscriptionId, record] of this.records) {
      if (record.requestId === requestId) {
        this.cancel(subscriptionId)
      }
    }
  }

  countForOperation(operationKey: string): number {
    return operationKey === this.options.operationKey ? this.records.size : 0
  }

  /** Why a closure here but not in `dispose`: the page document outlives a client swap, so a silent
   *  teardown would leave it holding a subscription nothing will ever feed again. */
  closeAll(closure: MobileWebSubscriptionClosure): void {
    for (const subscriptionId of this.records.keys()) {
      this.cancel(subscriptionId, closure)
    }
  }

  dispose(): void {
    for (const subscriptionId of this.records.keys()) {
      this.cancel(subscriptionId)
    }
  }

  /** Rejects a duplicate page subscription ID and enforces the per-shell subscription ceiling. */
  protected admit(subscriptionId: string): void {
    if (this.records.has(subscriptionId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new MobileWebBrokerError('rate_limited')
    }
  }

  protected newRecord(requestId: string): MobileWebSubscriptionRecord {
    return {
      requestId,
      sequence: 0,
      active: true,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
  }

  /** Why the re-read after `subscribe`: a host that delivers synchronously can cancel this record
   *  before `subscribe` returns, and the late handle would then outlive the page authority. */
  protected open(subscriptionId: string, record: TRecord, subscribe: () => () => void): void {
    this.records.set(subscriptionId, record)
    try {
      const unsubscribe = subscribe()
      if (record.active && this.records.get(subscriptionId) === record) {
        record.unsubscribe = unsubscribe
      } else {
        unsubscribe()
      }
    } catch {
      this.cancel(subscriptionId)
      throw new MobileWebBrokerError('host_error')
    }
  }

  protected isCurrent(subscriptionId: string, record: TRecord): boolean {
    return record.active && this.options.isActive() && this.records.get(subscriptionId) === record
  }

  protected enqueue(
    subscriptionId: string,
    record: TRecord,
    event: TEvent,
    retireAfterDelivery = false
  ): void {
    const sequence = record.sequence
    record.sequence += 1
    this.enqueueTask(subscriptionId, record, async () => {
      await this.options.postEvent(subscriptionId, sequence, event)
      if (retireAfterDelivery) {
        this.cancel(subscriptionId)
      }
    })
  }

  protected enqueueTask(subscriptionId: string, record: TRecord, task: () => Promise<void>): void {
    record.delivery = record.delivery
      .then(async () => {
        if (this.isCurrent(subscriptionId, record) && this.canDeliver(subscriptionId, record)) {
          await task()
        }
      })
      .catch(() => {
        this.cancel(subscriptionId, { code: 'unavailable', retryable: true })
      })
  }

  /** Re-checked at delivery time so a binding revoked while queued cannot publish. */
  protected canDeliver(_subscriptionId: string, _record: TRecord): boolean {
    return true
  }

  /** Runs while the record is being removed, before the host handle is released. */
  protected retire(_record: TRecord): void {}
}
