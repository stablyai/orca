import { mobileWebHostPayloadByteLength } from '../../../src/shared/mobile-web/host-rpc-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  assertMobileWebHostRequestScope,
  prepareMobileWebHostRequest,
  type MobileWebHostRequestArguments,
  type MobileWebHostRequestScope
} from './mobile-web-host-requests'
import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type HostStreamRecord = MobileWebSubscriptionRecord & {
  scope: MobileWebHostRequestScope | undefined
  closing: boolean
}

export class MobileWebHostSubscriptions extends MobileWebSubscriptionLedger<
  unknown,
  HostStreamRecord
> {
  constructor(
    private readonly config: MobileWebSubscriptionLedgerConfig<unknown> & {
      workspaceAuthority: MobileWebWorkspaceAuthority
    }
  ) {
    super({ ...config, operationKey: 'workspace.hostSubscribe' })
  }

  start(
    args: Omit<MobileWebHostRequestArguments, 'authority'> & {
      requestId: string
      subscriptionId: string
    }
  ): void {
    this.admit(args.subscriptionId)
    const { payload, scope, params, serverUnsubscribeMethod } = prepareMobileWebHostRequest({
      ...args,
      authority: this.config.workspaceAuthority
    })
    if (serverUnsubscribeMethod === undefined) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    const record: HostStreamRecord = { ...this.newRecord(args.requestId), scope, closing: false }
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe(
        payload.method,
        params,
        (event) => this.receive(args.subscriptionId, record, event),
        { serverUnsubscribeMethod }
      )
    )
  }

  protected override canDeliver(subscriptionId: string, record: HostStreamRecord): boolean {
    try {
      assertMobileWebHostRequestScope(this.config.workspaceAuthority, record.scope)
      return true
    } catch {
      this.cancel(subscriptionId, { code: 'not_found', retryable: false })
      return false
    }
  }

  private receive(subscriptionId: string, record: HostStreamRecord, event: unknown): void {
    if (
      record.closing ||
      !this.isCurrent(subscriptionId, record) ||
      !this.canDeliver(subscriptionId, record)
    ) {
      return
    }
    const bytes = mobileWebHostPayloadByteLength(event)
    if (bytes === undefined) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    const type =
      typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
    record.closing = type === 'end' || type === 'error'
    this.enqueue(subscriptionId, record, event, record.closing, bytes)
  }
}
