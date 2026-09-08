import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig
} from './mobile-web-subscription-ledger'
import type { MobileWebSpeechEvent } from '../../../src/shared/mobile-web/speech-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

/** Push-driven: the shell's own dictation runtime feeds every entry, so there is no host handle to
 *  open and no `closeAll` on a client swap — the authority publishes `session-replaced` instead. */
export class MobileWebSpeechSubscriptions extends MobileWebSubscriptionLedger<MobileWebSpeechEvent> {
  private disposed = false

  constructor(config: MobileWebSubscriptionLedgerConfig<MobileWebSpeechEvent>) {
    super({ ...config, operationKey: 'speech.subscribe' })
  }

  start(args: { requestId: string; subscriptionId: string }): void {
    if (this.disposed) {
      throw new MobileWebBrokerError('invalid_request')
    }
    this.admit(args.subscriptionId)
    this.records.set(args.subscriptionId, this.newRecord(args.requestId))
  }

  post(event: MobileWebSpeechEvent): void {
    for (const [subscriptionId, record] of this.records) {
      this.enqueue(subscriptionId, record, event)
    }
  }

  override dispose(): void {
    this.disposed = true
    super.dispose()
  }
}
