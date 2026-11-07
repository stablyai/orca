import type { RuntimeTransportMetadata } from '../../../../shared/runtime-bootstrap'
import { watchRuntimeMetadataOwnership } from '../../runtime-metadata-ownership-watch'
import type { RpcTransport } from '../transport'
import { UnixSocketTransport } from '../unix-socket-transport'
import { PinnedPortUnavailableError, WebSocketTransport } from '../ws-transport'
import {
  clearWsFallbackPort,
  readWsFallbackPort,
  wsFallbackPortLadder,
  writeWsFallbackPort
} from '../ws-fallback-port-store'
import { createServeNetworkSourceGuard } from './serve-network-source-policy'
import { RuntimeRpcMobileTransportLifecycle } from './runtime-rpc-mobile-transport-lifecycle'
import {
  formatWsEndpoint,
  WS_BIND_HOST_ALL_INTERFACES,
  WS_BIND_HOST_LOOPBACK
} from './runtime-rpc-pairing-types'
import {
  createRuntimeTransportMetadata,
  sweepOrphanedRuntimeSockets
} from './runtime-rpc-socket-metadata'
import { errorMessage } from '../../../../shared/error-message'
import {
  loadHostDescriptor,
  publishHostDescriptor
} from '../../hosts/platform-probe/host-descriptor'

export class RuntimeRpcLifecycle extends RuntimeRpcMobileTransportLifecycle {
  /** Publish local RPC independently of iroh readiness, cleaning up transports if metadata fails. */
  async start(): Promise<void> {
    if (this.stopping || this.activeTransports.length > 0) {
      return
    }

    // Sweep sockets orphaned by SIGKILL/OOM; Windows pipes leave no files.
    if (this.platform !== 'win32') {
      sweepOrphanedRuntimeSockets(this.userDataPath, this.pid)
    }

    const transportMeta = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )

    const socketTransport = new UnixSocketTransport({
      endpoint: transportMeta.endpoint,
      kind: transportMeta.kind as 'unix' | 'named-pipe',
      keepaliveIntervalMs: this.keepaliveIntervalMs
    })

    // Always reply on unexpected throws so clients and dispatch controllers cannot be stranded.
    socketTransport.onMessage((msg, reply, context) => {
      void this.trackClientRequest(() => this.handleMessage(msg, context))
        .then((response) => {
          reply(JSON.stringify(response))
        })
        .catch((error) => {
          const message = errorMessage(error)
          // Recover request id best-effort so clients can correlate failure.
          let id = 'unknown'
          try {
            const parsed = JSON.parse(msg) as { id?: unknown }
            if (typeof parsed.id === 'string' && parsed.id.length > 0) {
              id = parsed.id
            }
          } catch {}
          reply(JSON.stringify(this.buildError(id, 'internal_error', message)))
        })
    })

    await socketTransport.start()
    if (this.stopping) {
      await socketTransport.stop()
      return
    }

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]
    this.activeTransports = activeTransports

    // Per-device tokens/E2EE avoid React Native's inability to pin self-signed TLS certificates.
    if (this.enableWebSocket) {
      // Flush deferred lastSeen before replacement registry reads disk.
      this.deviceRegistry?.flushPendingLastSeen()
      const pairingIdentity = this.initializePairingIdentity()
      if (!pairingIdentity.ok) {
        this.deviceRegistry = null
        this.e2eeKeypair = null
        this.pairingInitializationFailure = pairingIdentity.failure
      } else {
        this.deviceRegistry = pairingIdentity.deviceRegistry
        this.e2eeKeypair = pairingIdentity.e2eeKeypair
        this.pairingInitializationFailure = null
        this.hostDescriptor = await loadHostDescriptor(this.userDataPath)
        if (this.stopping) {
          return
        }
        publishHostDescriptor(this.runtime.getRuntimeId(), this.hostDescriptor)
        try {
          const host = this.resolveInitialWebSocketBindHost()
          this.webSocketSourceGuard = createServeNetworkSourceGuard({
            options: this.serveNetworkSources,
            bindHost: host,
            userDataPath: this.userDataPath,
            devices: pairingIdentity.deviceRegistry.listDevices()
          })
          const { transport, endpoint } = await this.startWebSocketTransport({
            host,
            port: this.wsPort,
            preferPinnedPort: this.preferPinnedWsPort,
            requirePinnedPort: this.requirePinnedWsPort,
            // Persist fallback ports for paired endpoints (STA-1511); explicit zero remains random for E2E.
            ...(this.wsPort !== 0 ? { fallbackPort: readWsFallbackPort(this.userDataPath) } : {})
          })
          if (this.stopping) {
            await transport.stop()
            return
          }
          if (this.wsPort !== 0 && transport.resolvedPort !== this.wsPort) {
            writeWsFallbackPort(this.userDataPath, transport.resolvedPort)
          } else if (transport.persistedFallbackFailed) {
            clearWsFallbackPort(this.userDataPath)
          }
          activeTransports.push(transport)
          transportsMeta.push({ kind: 'websocket', endpoint })
        } catch (error) {
          // WS is supplementary unless an explicit port pin requires this listener.
          console.error('[runtime] Failed to start WebSocket transport:', error)
          if (error instanceof PinnedPortUnavailableError) {
            this.mobileSocketWiring?.dispose()
            this.mobileSocketWiring = null
            await socketTransport.stop().catch(() => {})
            throw error
          }
        }

        // Iroh is supplementary: an unavailable relay must not delay local/WS discovery.
        this.irohRuntimeStarted = true
        void this.ensureIrohRelayBinding().catch(() => {
          console.error('[runtime] Failed to initialize Iroh transport')
        })
      }
    }

    if (this.stopping) {
      return
    }
    // Set live endpoint/token before metadata publication.
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Without metadata CLI cannot discover runtime; close transports rather than serve invisibly.
      this.stopping = true
      this.irohRelayRetry.cancel()
      await this.pendingIrohTransport?.stop().catch(() => {})
      await this.waitForIrohRelayBinding()
      const transports = this.activeTransports
      this.activeTransports = []
      this.transports = []
      await Promise.all(transports.map((t) => t.stop().catch(() => {}))).catch(() => {})
      throw error
    }

    this.metadataOwnershipWatch = watchRuntimeMetadataOwnership({
      userDataPath: this.userDataPath,
      ownedPid: this.pid,
      ownedRuntimeId: this.runtime.getRuntimeId(),
      pollIntervalMs: this.metadataOwnershipPollMs,
      republish: () => {
        // Never publish torn-down endpoints.
        if (this.activeTransports.length === 0) {
          return
        }
        this.writeMetadata()
      },
      onReclaim: (previous) => {
        console.warn(
          `[runtime] Reclaimed orca-runtime.json from a dead runtime (pid ${previous?.pid ?? 'none'}); republished pid ${this.pid}.`
        )
      }
    })
  }

  /** Keep WS loopback unless explicit exposure or a connected non-iroh network grant requires it. */
  protected resolveInitialWebSocketBindHost(): string {
    if (this.pinnedBindHost) {
      return this.pinnedBindHost
    }
    if (this.exposeNetworkByDefault) {
      return WS_BIND_HOST_ALL_INTERFACES
    }
    const hasConnectedNetworkDevice =
      this.deviceRegistry
        ?.listDevices()
        .some(
          (device) =>
            device.lastSeenAt > 0 &&
            device.pairingReach !== 'this-computer' &&
            !(device.scope === 'mobile' && device.mobilePairingConnectionMode === 'iroh')
        ) ?? false
    return hasConnectedNetworkDevice ? WS_BIND_HOST_ALL_INTERFACES : WS_BIND_HOST_LOOPBACK
  }

  // Share WS construction/wiring between startup and pairing-time rebind.
  protected async startWebSocketTransport(options: {
    host: string
    port: number
    preferPinnedPort: boolean
    requirePinnedPort?: boolean
    fallbackPort?: number
  }): Promise<{ transport: WebSocketTransport; endpoint: string }> {
    const deviceRegistry = this.deviceRegistry
    const e2eeKeypair = this.e2eeKeypair
    if (!deviceRegistry || !e2eeKeypair) {
      throw new Error('WebSocket transport requires an initialized pairing identity')
    }
    const wsTransport = new WebSocketTransport({
      host: options.host,
      port: options.port,
      staticRoot: this.webClientRoot,
      ...(this.webSocketSourceGuard ? { sourceGuard: this.webSocketSourceGuard } : {}),
      ...(options.fallbackPort !== undefined ? { fallbackPort: options.fallbackPort } : {}),
      ...(options.preferPinnedPort ? { preferPinnedPort: true } : {}),
      ...(options.requirePinnedPort ? { requirePinnedPort: true } : {}),
      fallbackLadder: wsFallbackPortLadder(this.wsPort)
    })
    const mobileSocketWiring = this.ensureMobileSocketWiring(deviceRegistry, e2eeKeypair)
    this.detachWebSocketWiring = mobileSocketWiring.attachTransport(wsTransport, (ws) => {
      const sourceClass = wsTransport.sourceClassOf(ws)
      return sourceClass ? { transport: 'direct', sourceClass } : { transport: 'direct' }
    })

    try {
      await wsTransport.start()
    } catch (error) {
      // Detach listeners that failed to bind so session wiring never retains dead revocation targets.
      this.detachWebSocketWiring?.()
      this.detachWebSocketWiring = null
      throw error
    }
    this.wsBoundHost = options.host
    return {
      transport: wsTransport,
      endpoint: formatWsEndpoint(options.host, wsTransport.resolvedPort)
    }
  }
}
