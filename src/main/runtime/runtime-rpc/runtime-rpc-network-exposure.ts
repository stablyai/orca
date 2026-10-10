import { WebSocketTransport } from '../rpc/ws-transport'
import { writeWsFallbackPort } from '../rpc/ws-fallback-port-store'
import { RuntimeRpcLifecycle } from './runtime-rpc-lifecycle'
import { WS_BIND_HOST_ALL_INTERFACES, WS_BIND_HOST_LOOPBACK } from './runtime-rpc-pairing-types'

export class RuntimeRpcNetworkExposure extends RuntimeRpcLifecycle {
  // Why: STA-2370 — widen the loopback listener to all interfaces so a freshly generated pairing
  // offer's advertised LAN endpoint is reachable. Idempotent, but it is no longer confined to the first
  // pairing action: a "This computer only" link never widens, so live loopback clients can already be
  // connected when a later LAN/QR offer opts in. Rebinding terminates them (ws cannot move a listener),
  // so the resolved port is reused — already-issued endpoints stay valid and clients reconnect in place.
  async ensureNetworkExposure(): Promise<void> {
    if (this.pinnedBindHost && this.pinnedBindHost !== WS_BIND_HOST_ALL_INTERFACES) {
      // Why throw and not return: callers widen so they can ADVERTISE a LAN endpoint. Returning
      // quietly would let them publish one that nothing can reach; the throw lands in their
      // existing network_exposure_failed branch, which reports the offer unavailable instead.
      throw new Error(
        `Runtime bind address is pinned to ${this.pinnedBindHost}; refusing to widen to all interfaces`
      )
    }
    if (
      !this.enableWebSocket ||
      this.stopping ||
      this.wsBoundHost === WS_BIND_HOST_ALL_INTERFACES
    ) {
      return
    }
    // Why: concurrent pairing requests must share one rebind — two simultaneous stop/start races would
    // fight for the port and strand the listener on a random one.
    if (!this.networkExposurePromise) {
      this.networkExposurePromise = this.widenWebSocketBind().finally(() => {
        this.networkExposurePromise = null
      })
    }
    return this.networkExposurePromise
  }

  protected async widenWebSocketBind(): Promise<void> {
    const current = this.activeTransports.find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )
    if (!current) {
      return
    }
    const index = this.activeTransports.indexOf(current)
    const previousPort = current.resolvedPort
    let widened: { transport: WebSocketTransport; endpoint: string }
    try {
      // Why: detach the loopback listener from the session wiring before stopping it so terminateDevice-
      // Connections never iterates a dead transport; the new listener re-attaches to the SAME wiring.
      this.detachWebSocketWiring?.()
      await current.stop()
      widened = await this.startWebSocketTransport({
        host: WS_BIND_HOST_ALL_INTERFACES,
        port: previousPort,
        preferPinnedPort: true
      })
    } catch (error) {
      // Why: the wide bind failed after the loopback listener was already stopped. Restore a serving
      // loopback listener on the same port (wsBoundHost stays loopback so a later offer retries), then
      // propagate — the caller must not advertise a LAN endpoint with no LAN listener behind it (STA-2370).
      console.error('[runtime] Failed to widen WebSocket transport for pairing:', error)
      await this.recoverWebSocketBindAfterFailedWiden(index, previousPort)
      throw error
    }
    // Why: register the live wide transport BEFORE persisting metadata so a metadata-write failure can
    // never orphan a running 0.0.0.0 listener outside activeTransports (and thus outside stop()).
    this.activeTransports[index] = widened.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex !== -1) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: widened.endpoint }
    }
    try {
      // Why: a rebind that lands on a different port (same-port bind refused) must be persisted so a
      // later reconnect from a device paired to this port matches on the next launch (STA-1511).
      if (this.wsPort !== 0 && widened.transport.resolvedPort !== this.wsPort) {
        writeWsFallbackPort(this.userDataPath, widened.transport.resolvedPort)
      }
      this.writeMetadata()
    } catch (persistError) {
      // Why: the wide listener is live and tracked; a persistence failure must not tear it down. Keep
      // serving — the in-memory endpoint is already correct.
      console.error(
        '[runtime] Widened WebSocket listener but failed to persist pairing metadata:',
        persistError
      )
    }
  }

  // Why: a failed widen already tore down the loopback listener; bring one back on the same host/port so the
  // runtime keeps serving locally (wsBoundHost stays loopback, so the next pairing offer retries the widen).
  protected async recoverWebSocketBindAfterFailedWiden(
    index: number,
    previousPort: number
  ): Promise<void> {
    let restored: { transport: WebSocketTransport; endpoint: string }
    try {
      restored = await this.startWebSocketTransport({
        host: WS_BIND_HOST_LOOPBACK,
        port: previousPort,
        preferPinnedPort: true
      })
    } catch (recoveryError) {
      // Why: even the loopback restore failed — drop the dead WebSocket transport so we never advertise an
      // endpoint with no listener. The Unix socket keeps serving and a restart re-establishes the listener.
      console.error(
        '[runtime] Failed to restore WebSocket transport after widen failure:',
        recoveryError
      )
      this.activeTransports.splice(index, 1)
      const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
      if (metaIndex !== -1) {
        this.transports.splice(metaIndex, 1)
      }
      this.wsBoundHost = null
      try {
        this.writeMetadata()
      } catch {
        // Why: metadata already reflects the torn-down listener; nothing else to recover here.
      }
      return
    }
    // Why: register the restored loopback listener BEFORE persisting metadata so a write failure can never
    // orphan a live transport outside activeTransports (and thus outside stop()).
    this.activeTransports[index] = restored.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex !== -1) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: restored.endpoint }
    }
    try {
      this.writeMetadata()
    } catch (persistError) {
      // Why: the loopback listener is live and tracked; a persistence failure must not tear it down.
      console.error(
        '[runtime] Restored loopback WebSocket listener but failed to persist metadata:',
        persistError
      )
    }
  }
}
