import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import type { MobileWebHostWorkspaceId } from './mobile-web-workspace-authority'
import {
  MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
  type MobileWebSessionSnapshotResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'

type SessionLedgerConfig = MobileWebSubscriptionLedgerConfig<MobileWebSessionSnapshotResult> & {
  browserAuthority: MobileWebBrowserAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
}

export class MobileWebSessionSubscriptions extends MobileWebSubscriptionLedger<MobileWebSessionSnapshotResult> {
  constructor(private readonly config: SessionLedgerConfig) {
    super({ ...config, operationKey: 'session.subscribe' })
  }

  start(args: {
    requestId: string
    subscriptionId: string
    pageWorkspaceId: string
    hostWorkspaceId: MobileWebHostWorkspaceId
    client: RpcClient
  }): void {
    this.admit(args.subscriptionId)
    const record = this.newRecord(args.requestId)
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe(
        'session.tabs.subscribe',
        { worktree: `id:${args.hostWorkspaceId}` },
        (event) =>
          this.receive(
            args.subscriptionId,
            record,
            args.hostWorkspaceId,
            args.pageWorkspaceId,
            event
          )
      )
    )
  }

  private receive(
    subscriptionId: string,
    record: MobileWebSubscriptionRecord,
    hostWorkspaceId: MobileWebHostWorkspaceId,
    pageWorkspaceId: string,
    event: unknown
  ): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    let snapshot: MobileWebSessionSnapshotResult
    try {
      snapshot = mobileWebSessionSnapshot(
        event,
        hostWorkspaceId,
        pageWorkspaceId,
        this.config.browserAuthority,
        this.config.nativeChatAuthority
      )
    } catch {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    // Why still here: the projection already trims tabs to fit, so this only fires on an envelope
    // no bounded tab list can rescue — and now it says so instead of going quiet.
    if (encodedByteLength(snapshot) > MOBILE_WEB_SESSION_EVENT_MAX_BYTES) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    this.enqueue(subscriptionId, record, snapshot)
  }
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
