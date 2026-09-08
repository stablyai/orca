import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebTerminalStreamRecord } from './mobile-web-terminal-flow-control'
import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { safeUnsubscribeMobileWebTerminal } from './mobile-web-terminal-host-transport'
import type { MobileWebTerminalStreamRegistry } from './mobile-web-terminal-stream-registry'

/** The page cannot observe a shell-side retirement: its terminal keeps a live entry, freezes on the
 *  last frame it got and never re-subscribes. So every retirement the page did not ask for carries a
 *  closure, and every retirement drops the host stream first — a retired record is unreachable from
 *  the registry, so no later sweep can unsubscribe it. */
export const MOBILE_WEB_TERMINAL_AUTHORITY_CLOSURE: MobileWebSubscriptionClosure = {
  code: 'not_found',
  retryable: false
}
export const MOBILE_WEB_TERMINAL_DELIVERY_CLOSURE: MobileWebSubscriptionClosure = {
  code: 'unavailable',
  retryable: true
}
/** A client swap keeps the page and its grants, so re-subscribing on the new transport works. */
export const MOBILE_WEB_TERMINAL_CLIENT_CLOSURE: MobileWebSubscriptionClosure = {
  code: 'cancelled',
  retryable: true
}

export class MobileWebTerminalStreamRetirement {
  constructor(
    private readonly options: {
      registry: MobileWebTerminalStreamRegistry
      postClosed: MobileWebPostSubscriptionClosed
    }
  ) {}

  retire(
    record: MobileWebTerminalStreamRecord,
    client: RpcClient | null,
    closure?: MobileWebSubscriptionClosure
  ): void {
    if (client) {
      safeUnsubscribeMobileWebTerminal(client, record)
    }
    this.options.registry.retire(record)
    if (closure) {
      this.options.postClosed(record.subscriptionId, closure)
    }
  }
}
