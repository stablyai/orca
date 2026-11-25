// Refuses public-address peers at TCP accept, before HTTP parsing or the WebSocket upgrade.
import { classifyNetworkSource, normalizeSourceAddress } from './network-source-class'
import { OnLinkPrefixes } from './on-link-prefixes'

const REFUSAL_LOG_INTERVAL_MS = 60 * 60_000

export type WebSocketSourceGuard = {
  admit(remoteAddress: string | undefined): boolean
}

export class PublicSourceRefusal implements WebSocketSourceGuard {
  private lastLogAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly onLink: Pick<OnLinkPrefixes, 'contains'> = new OnLinkPrefixes(),
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.warn
  ) {}

  admit(remoteAddress: string | undefined): boolean {
    // Unclassifiable means the peer already left; nothing to refuse.
    if (classifyNetworkSource(remoteAddress) !== 'public') {
      return true
    }
    // A global address on one of our own interface prefixes is a same-network (LAN) peer.
    if (this.onLink.contains(remoteAddress)) {
      return true
    }
    const now = this.now()
    if (now - this.lastLogAt >= REFUSAL_LOG_INTERVAL_MS) {
      this.lastLogAt = now
      this.log(
        `[runtime] Refused a connection from public address ${normalizeSourceAddress(remoteAddress)}. ` +
          'This server accepts localhost, LAN and Tailscale addresses; restart orca serve with ' +
          '--allow-public to accept public addresses. Further refusals this hour are not logged.'
      )
    }
    return false
  }
}
