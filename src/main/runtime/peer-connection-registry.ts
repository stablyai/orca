import type WebSocket from 'ws'

// Why: tracks live peer-desktop WebSocket sessions so the host can list who is
// currently connected in real time, distinct from DeviceRegistry's paired-but-
// possibly-offline entries.
export type PeerConnectionInfo = {
  connectionId: string
  deviceId: string
  name: string
  connectedAt: number
}

type PeerConnectionEntry = PeerConnectionInfo & { ws: WebSocket }

export class PeerConnectionRegistry {
  private readonly connections = new Map<string, PeerConnectionEntry>()

  add(info: PeerConnectionInfo, ws: WebSocket): void {
    this.connections.set(info.connectionId, { ...info, ws })
  }

  // Why: return value lets callers tell "was tracked as a live connection" from
  // "was never added" (e.g. a duplicate rejected before add()).
  remove(connectionId: string): boolean {
    return this.connections.delete(connectionId)
  }

  list(): PeerConnectionInfo[] {
    return Array.from(this.connections.values()).map(({ ws: _ws, ...info }) => info)
  }

  // Why: a pairing code pasted into two clients reuses the same deviceId
  // (DeviceRegistry's pending-device slot is keyed by scope, not connection),
  // so the caller uses this to reject a second live connection instead of
  // letting both share one deviceId's grants and disconnect switch. Entries
  // whose socket already closed (e.g. an unclean disconnect) are pruned here
  // so a legitimate reconnect with the same code is never blocked.
  findLiveConnectionByDevice(deviceId: string): PeerConnectionInfo | null {
    for (const entry of this.connections.values()) {
      if (entry.deviceId !== deviceId) {
        continue
      }
      if (entry.ws.readyState === entry.ws.OPEN) {
        return entry
      }
      this.connections.delete(entry.connectionId)
    }
    return null
  }

  // Why: hosting-disabled toggle must drop every live peer socket at once;
  // the WS 'close' handler removes each entry from this registry itself.
  closeAll(code: number, reason: string): void {
    for (const entry of this.connections.values()) {
      entry.ws.close(code, reason)
    }
  }

  // Why: host-initiated disconnect of one device. The graceful close carries
  // the code across, so the client can latch closed instead of treating it as
  // a network drop and reconnecting a second later.
  closeByDevice(deviceId: string, code: number, reason: string): number {
    let closed = 0
    for (const entry of this.connections.values()) {
      if (entry.deviceId === deviceId) {
        entry.ws.close(code, reason)
        closed++
      }
    }
    return closed
  }
}
