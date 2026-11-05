import { WebSocketTransport } from '../rpc/ws-transport'
import { writeWsFallbackPort } from '../rpc/ws-fallback-port-store'
import { RuntimeRpcLifecycle } from './runtime-rpc-lifecycle'
import { WS_BIND_HOST_ALL_INTERFACES, WS_BIND_HOST_LOOPBACK } from './runtime-rpc-pairing-types'

export class RuntimeRpcNetworkExposure extends RuntimeRpcLifecycle {
  // Advertise addresses the widened listener will answer, not its current loopback bind.
  getNetworkExposureBindHost(): string {
    return this.pinnedBindHost ?? WS_BIND_HOST_ALL_INTERFACES
  }

  // LAN opt-in rebinds loopback and disconnects local clients; reuse their already-issued port so all endpoints can reconnect (STA-2370).
  async ensureNetworkExposure(): Promise<void> {
    if (this.pinnedBindHost && this.pinnedBindHost !== WS_BIND_HOST_ALL_INTERFACES) {
      // Throw on failed widening so callers return network_exposure_failed rather than advertise unreachable LAN.
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
    // Coalesce pairing rebinds or competing stop/start races can strand the listener on another port.
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
      // Detach old listener, then reattach new transport to the same wiring so relay state/revocation survive.
      this.detachWebSocketWiring?.()
      await current.stop()
      widened = await this.startWebSocketTransport({
        host: WS_BIND_HOST_ALL_INTERFACES,
        port: previousPort,
        preferPinnedPort: true
      })
    } catch (error) {
      // Failed wide bind must restore loopback on the same port, retain retry state, then propagate failure; never advertise unserved LAN.
      console.error('[runtime] Failed to widen WebSocket transport for pairing:', error)
      await this.recoverWebSocketBindAfterFailedWiden(index, previousPort)
      throw error
    }
    // Track live wide transport before metadata write so persistence failure cannot orphan it outside shutdown.
    this.activeTransports[index] = widened.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex !== -1) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: widened.endpoint }
    }
    try {
      // Persist any fallback port so paired endpoints match it on restart (STA-1511).
      if (this.wsPort !== 0 && widened.transport.resolvedPort !== this.wsPort) {
        writeWsFallbackPort(this.userDataPath, widened.transport.resolvedPort)
      }
      this.writeMetadata()
    } catch (persistError) {
      // Persistence failure cannot undo an already-live tracked listener; in-memory endpoint is valid.
      console.error(
        '[runtime] Widened WebSocket listener but failed to persist pairing metadata:',
        persistError
      )
    }
  }

  // Restore a failed widen's loopback listener; retain loopback bound-host state for later exposure retry.
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
      // If loopback recovery also fails, drop dead WS metadata; Unix still serves until restart.
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
        // Metadata already describes the removed listener; no further recovery needed.
      }
      return
    }
    // Track restored loopback before persistence so write failure cannot orphan a live listener.
    this.activeTransports[index] = restored.transport
    const metaIndex = this.transports.findIndex((meta) => meta.kind === 'websocket')
    if (metaIndex !== -1) {
      this.transports[metaIndex] = { kind: 'websocket', endpoint: restored.endpoint }
    }
    try {
      this.writeMetadata()
    } catch (persistError) {
      // Keep serving through persistence failure; loopback is already live and tracked.
      console.error(
        '[runtime] Restored loopback WebSocket listener but failed to persist metadata:',
        persistError
      )
    }
  }
}
