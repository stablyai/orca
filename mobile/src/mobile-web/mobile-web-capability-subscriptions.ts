import { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type {
  MobileWebSubscriptionLedgerConfig,
  MobileWebSubscriptionLedgerHandle
} from './mobile-web-subscription-ledger'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebNativeChatSubscriptions } from './mobile-web-native-chat-subscriptions'
import { MobileWebSourceControlSubscriptions } from './mobile-web-source-control-subscriptions'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'

export class MobileWebCapabilitySubscriptions {
  readonly account: MobileWebAccountSubscriptions
  readonly browser: MobileWebBrowserStreams
  readonly nativeChat: MobileWebNativeChatSubscriptions
  readonly session: MobileWebSessionSubscriptions
  readonly sourceControl: MobileWebSourceControlSubscriptions
  readonly workspace: MobileWebWorkspaceSubscriptions
  private readonly ledgers: MobileWebSubscriptionLedgerHandle[]

  constructor(
    args: MobileWebSubscriptionLedgerConfig<unknown> & {
      browserAuthority: MobileWebBrowserAuthority
      nativeChatAuthority: MobileWebNativeChatAuthority
      workspaceAuthority: MobileWebWorkspaceAuthority
    }
  ) {
    const shared = {
      isActive: args.isActive,
      postEvent: args.postEvent,
      postClosed: args.postClosed
    }
    this.account = new MobileWebAccountSubscriptions(shared)
    this.browser = new MobileWebBrowserStreams({
      ...shared,
      workspaceAuthority: args.workspaceAuthority,
      browserAuthority: args.browserAuthority
    })
    this.nativeChat = new MobileWebNativeChatSubscriptions({
      ...shared,
      nativeChatAuthority: args.nativeChatAuthority,
      workspaceAuthority: args.workspaceAuthority
    })
    this.session = new MobileWebSessionSubscriptions({
      ...shared,
      browserAuthority: args.browserAuthority,
      nativeChatAuthority: args.nativeChatAuthority
    })
    this.sourceControl = new MobileWebSourceControlSubscriptions({
      ...shared,
      workspaceAuthority: args.workspaceAuthority
    })
    this.workspace = new MobileWebWorkspaceSubscriptions(shared)
    this.ledgers = [
      this.account,
      this.browser,
      this.nativeChat,
      this.session,
      this.sourceControl,
      this.workspace
    ]
  }

  countForOperation(operationKey: string): number {
    let count = 0
    for (const ledger of this.ledgers) {
      count += ledger.countForOperation(operationKey)
    }
    return count
  }

  cancel(subscriptionId: string): string | null {
    for (const ledger of this.ledgers) {
      const requestId = ledger.cancel(subscriptionId)
      if (requestId !== null) {
        return requestId
      }
    }
    return null
  }

  cancelByRequest(requestId: string): void {
    for (const ledger of this.ledgers) {
      ledger.cancelByRequest(requestId)
    }
  }

  /** Used when the page survives but its host feed does not, so every live entry learns it is over. */
  closeAll(closure: MobileWebSubscriptionClosure): void {
    for (const ledger of this.ledgers) {
      ledger.closeAll(closure)
    }
  }

  dispose(): void {
    for (const ledger of this.ledgers) {
      ledger.dispose()
    }
  }
}
