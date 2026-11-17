// A Zotz server node only answers its own machine and the tailnet; LAN and public peers are refused.
import {
  classifyNetworkSource,
  normalizeSourceAddress
} from '../runtime/rpc/transports/websocket/source-admission/network-source-class'
import type { WebSocketSourceGuard } from '../runtime/rpc/transports/websocket/source-admission/ws-network-source-guard'

const REFUSAL_LOG_INTERVAL_MS = 60 * 60_000

export class ZotzTailnetOnlySourceGuard implements WebSocketSourceGuard {
  private lastLogAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = console.warn
  ) {}

  admit(remoteAddress: string | undefined): boolean {
    const source = classifyNetworkSource(remoteAddress)
    // Unclassifiable means the peer already left; nothing to refuse.
    if (source === null || source === 'loopback' || source === 'tailnet') {
      return true
    }
    const now = this.now()
    if (now - this.lastLogAt >= REFUSAL_LOG_INTERVAL_MS) {
      this.lastLogAt = now
      this.log(
        `[runtime] Refused a connection from ${source} address ${normalizeSourceAddress(remoteAddress)}. ` +
          'Zotz in server mode only accepts this machine and Tailscale (100.64.0.0/10). ' +
          'Further refusals this hour are not logged.'
      )
    }
    return false
  }
}
