import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'
import type { PairingOffer } from '../../shared/pairing'
import type { PeerClientRpcChannel } from './peer-client-rpc-channel'

type PeerPresenceStreamEntry = {
  onEvent: (event: PeerPresenceEvent) => void
  subscriptionId: string | null
}

export type PeerClientPresenceStreamsDeps = {
  rpc: PeerClientRpcChannel
  getOffer: () => PairingOffer | null
  getHandshakeState: () => 'awaiting_ready' | 'awaiting_auth' | 'ready'
  getClientId: () => string | null
  nextCounter: () => number
}

// Why: one subscribe per open remote terminal panel receives every other
// participant's cursor/scroll/selection; unlike terminal.subscribe there is
// no binary stream, so this just tracks the requestId -> callback mapping.
export class PeerClientPresenceStreams {
  private readonly byRequestId = new Map<string, PeerPresenceStreamEntry>()

  constructor(private readonly deps: PeerClientPresenceStreamsDeps) {}

  subscribe(
    terminal: string,
    onEvent: (event: PeerPresenceEvent) => void
  ): { ok: true; requestId: string } | { ok: false; reason: string } {
    const offer = this.deps.getOffer()
    if (!offer || this.deps.getHandshakeState() !== 'ready') {
      return { ok: false, reason: 'not_connected_to_a_peer_host' }
    }
    const id = `peer-presence-${this.deps.nextCounter()}-${Date.now()}`
    const sent = this.deps.rpc.sendEncrypted({
      id,
      deviceToken: offer.deviceToken,
      method: 'terminal.presence.subscribe',
      params: { terminal, clientId: this.deps.getClientId() }
    })
    if (!sent) {
      return { ok: false, reason: 'connection_interrupted' }
    }
    this.byRequestId.set(id, { onEvent, subscriptionId: null })
    return { ok: true, requestId: id }
  }

  unsubscribe(requestId: string): void {
    const entry = this.byRequestId.get(requestId)
    if (!entry) {
      return
    }
    this.byRequestId.delete(requestId)
    if (entry.subscriptionId) {
      void this.deps.rpc.sendRequest('terminal.presence.unsubscribe', {
        subscriptionId: entry.subscriptionId
      })
    }
  }

  // Why: fire-and-forget — the caller throttles to ~60Hz and must never
  // wait on a round trip, so this never touches the pending request map.
  send(terminal: string, state: PeerPresenceState): void {
    const offer = this.deps.getOffer()
    if (!offer || this.deps.getHandshakeState() !== 'ready') {
      return
    }
    this.deps.rpc.sendEncrypted({
      id: `peer-presence-send-${this.deps.nextCounter()}`,
      deviceToken: offer.deviceToken,
      method: 'terminal.presence.send',
      params: { terminal, state }
    })
  }

  endAll(): void {
    for (const entry of this.byRequestId.values()) {
      entry.onEvent({ type: 'end' })
    }
    this.byRequestId.clear()
  }

  // Why: terminal.presence.subscribe's streamed results already have the
  // PeerPresenceEvent shape (see terminal-presence.ts's emit calls), so this
  // just forwards them and drops the map entry once the stream ends.
  tryHandle(id: string, message: Record<string, unknown>): boolean {
    const entry = this.byRequestId.get(id)
    if (!entry) {
      return false
    }
    if (!message.ok) {
      this.byRequestId.delete(id)
      return true
    }
    const result = message.result as PeerPresenceEvent | null
    if (!result || typeof result !== 'object') {
      return true
    }
    if (result.type === 'ready') {
      entry.subscriptionId = result.subscriptionId
    }
    entry.onEvent(result)
    if (result.type === 'end') {
      this.byRequestId.delete(id)
    }
    return true
  }
}
