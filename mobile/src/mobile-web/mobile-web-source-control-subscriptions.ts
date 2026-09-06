import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import type { MobileWebSourceControlStatusInvalidation } from '../../../src/shared/mobile-web/source-control-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type WatchRecord = MobileWebSubscriptionRecord & {
  pageWorkspaceId: string
  hostWorkspaceId: string
  closing: boolean
}

type SourceControlLedgerConfig =
  MobileWebSubscriptionLedgerConfig<MobileWebSourceControlStatusInvalidation> & {
    workspaceAuthority: MobileWebWorkspaceAuthority
  }

const MAX_FILE_WATCH_EVENTS = 5_000

export class MobileWebSourceControlSubscriptions extends MobileWebSubscriptionLedger<
  MobileWebSourceControlStatusInvalidation,
  WatchRecord
> {
  constructor(private readonly config: SourceControlLedgerConfig) {
    super({ ...config, operationKey: 'sourceControl.subscribe' })
  }

  start(args: {
    requestId: string
    subscriptionId: string
    pageWorkspaceId: string
    hostWorkspaceId: string
    client: RpcClient
  }): void {
    this.admit(args.subscriptionId)
    const record: WatchRecord = {
      ...this.newRecord(args.requestId),
      pageWorkspaceId: args.pageWorkspaceId,
      hostWorkspaceId: args.hostWorkspaceId,
      closing: false
    }
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe('files.watch', { worktree: `id:${args.hostWorkspaceId}` }, (event) =>
        this.receive(args.subscriptionId, record, event)
      )
    )
  }

  protected override canDeliver(subscriptionId: string, record: WatchRecord): boolean {
    if (this.isAuthorized(record)) {
      return true
    }
    this.cancel(subscriptionId, { code: 'not_found', retryable: false })
    return false
  }

  private receive(subscriptionId: string, record: WatchRecord, value: unknown): void {
    if (!this.isAuthorized(record)) {
      this.cancel(subscriptionId, { code: 'not_found', retryable: false })
      return
    }
    if (record.closing || !this.isCurrent(subscriptionId, record)) {
      return
    }
    if (!isRecord(value)) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    if (value.type === 'starting' || value.type === 'ready') {
      return
    }
    if (value.type === 'changed') {
      this.receiveChange(subscriptionId, record, value)
      return
    }
    if (value.type === 'error' || value.type === 'end') {
      record.closing = true
      this.enqueue(
        subscriptionId,
        record,
        { workspaceId: record.pageWorkspaceId, reason: 'unavailable' },
        true
      )
      return
    }
    this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
  }

  private receiveChange(
    subscriptionId: string,
    record: WatchRecord,
    value: Record<string, unknown>
  ): void {
    if (value.worktree !== `id:${record.hostWorkspaceId}` || !Array.isArray(value.events)) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    const overflow =
      value.events.length > MAX_FILE_WATCH_EVENTS ||
      value.events.some((event) => isRecord(event) && event.kind === 'overflow')
    this.enqueue(subscriptionId, record, {
      workspaceId: record.pageWorkspaceId,
      reason: overflow ? 'overflow' : 'changed'
    })
  }

  private isAuthorized(record: WatchRecord): boolean {
    try {
      return (
        this.config.workspaceAuthority.hostWorkspaceId(record.pageWorkspaceId) ===
        record.hostWorkspaceId
      )
    } catch {
      return false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
