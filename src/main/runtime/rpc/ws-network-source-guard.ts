// Decides at TCP accept whether a peer is refused; refused peers get a reply naming the fix, never the RPC protocol.
import type { ServerResponse } from 'node:http'
import { classifyNetworkSource, normalizeSourceAddress } from './network-source-class'
import { OnLinkPrefixes } from './on-link-prefixes'

const REFUSAL_LOG_INTERVAL_MS = 60 * 60_000

// WebSocket close reasons are capped at 123 bytes; clients show this text.
export const PUBLIC_SOURCE_REFUSAL_REASON =
  'This Orca server refuses public addresses. Restart orca serve with --allow-public to accept them.'
export const PUBLIC_SOURCE_REFUSAL_CLOSE_CODE = 1008

export function answerRefusedSource(response: ServerResponse): void {
  response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
  response.end(`${PUBLIC_SOURCE_REFUSAL_REASON}\n`)
}

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
