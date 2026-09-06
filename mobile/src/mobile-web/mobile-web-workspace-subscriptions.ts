import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import {
  MobileWebWorkspaceChangeSchema,
  type MobileWebWorkspaceChange
} from '../../../src/shared/mobile-web/workspace-presentation-contract'
import type { RpcClient } from '../transport/rpc-client'

export class MobileWebWorkspaceSubscriptions extends MobileWebSubscriptionLedger<MobileWebWorkspaceChange> {
  constructor(config: MobileWebSubscriptionLedgerConfig<MobileWebWorkspaceChange>) {
    super({ ...config, operationKey: 'workspace.subscribe' })
  }

  start(args: { requestId: string; subscriptionId: string; client: RpcClient }): void {
    this.admit(args.subscriptionId)
    const record = this.newRecord(args.requestId)
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe('runtime.clientEvents.subscribe', null, (event) =>
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
    const parsed = workspaceChange(value)
    if (!parsed) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    this.enqueue(subscriptionId, record, parsed, parsed.type === 'end' || parsed.type === 'error')
  }
}

function workspaceChange(value: unknown): MobileWebWorkspaceChange | null {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return null
  }
  const parsed = MobileWebWorkspaceChangeSchema.safeParse({
    type: (value as { type: unknown }).type
  })
  return parsed.success ? parsed.data : null
}
