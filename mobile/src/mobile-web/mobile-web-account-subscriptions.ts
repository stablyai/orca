import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import type { MobileWebAccountEvent } from '../../../src/shared/mobile-web/account-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebAccountEvent } from './mobile-web-account-presentation'

export class MobileWebAccountSubscriptions extends MobileWebSubscriptionLedger<MobileWebAccountEvent> {
  constructor(config: MobileWebSubscriptionLedgerConfig<MobileWebAccountEvent>) {
    super({ ...config, operationKey: 'account.subscribe' })
  }

  start(args: { requestId: string; subscriptionId: string; client: RpcClient }): void {
    this.admit(args.subscriptionId)
    const record = this.newRecord(args.requestId)
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe('accounts.subscribe', null, (event) =>
        this.receive(args.subscriptionId, record, event)
      )
    )
  }

  private receive(
    subscriptionId: string,
    record: MobileWebSubscriptionRecord,
    value: unknown
  ): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    const event = mobileWebAccountEvent(value)
    if (!event) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    this.enqueue(subscriptionId, record, event, event.type === 'end' || event.type === 'error')
  }
}
