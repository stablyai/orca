import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../terminal/adoption/unshown-live-terminal-placement'
import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'
import { watchRuntimeMetadataOwnership } from '../runtime-metadata-ownership-watch'
import type { RpcTransport } from '../rpc/transport'
import { UnixSocketTransport } from '../rpc/unix-socket-transport'
import { PinnedPortUnavailableError, WebSocketTransport } from '../rpc/ws-transport'
import {
  clearWsFallbackPort,
  readWsFallbackPort,
  wsFallbackPortLadder,
  writeWsFallbackPort
} from '../rpc/ws-fallback-port-store'
import type { DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import { UnpairedDeviceAuthThrottle } from '../rpc/unpaired-device-auth-throttle'
import { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import { RuntimeRpcWebSocketDispatch } from './runtime-rpc-websocket-dispatch'
import {
  formatWsEndpoint,
  WS_BIND_HOST_ALL_INTERFACES,
  WS_BIND_HOST_LOOPBACK
} from './runtime-rpc-pairing-types'
import {
  createRuntimeTransportMetadata,
  sweepOrphanedRuntimeSockets
} from './runtime-rpc-socket-metadata'
import { errorMessage } from '../../../shared/error-message'
import { loadHostDescriptor, publishHostDescriptor } from '../host-descriptor'

export class RuntimeRpcLifecycle extends RuntimeRpcWebSocketDispatch {
  async start(): Promise<void> {
    if (this.activeTransports.length > 0) {
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

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]

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
        publishHostDescriptor(this.runtime.getRuntimeId(), this.hostDescriptor)
        try {
          const host = this.resolveInitialWebSocketBindHost()
          const { transport, endpoint } = await this.startWebSocketTransport({
            host,
            port: this.wsPort,
            preferPinnedPort: this.preferPinnedWsPort,
            requirePinnedPort: this.requirePinnedWsPort,
            // Persist fallback ports for paired endpoints (STA-1511); explicit zero remains random for E2E.
            ...(this.wsPort !== 0 ? { fallbackPort: readWsFallbackPort(this.userDataPath) } : {})
          })
          if (this.wsPort !== 0 && transport.resolvedPort !== this.wsPort) {
            writeWsFallbackPort(this.userDataPath, transport.resolvedPort)
          } else if (transport.persistedFallbackFailed) {
            clearWsFallbackPort(this.userDataPath)
          }
          activeTransports.push(transport)
          transportsMeta.push({ kind: 'websocket', endpoint })
        } catch (error) {
          // WS is supplementary; keep Unix transport serving if it fails.
          console.error('[runtime] Failed to start WebSocket transport:', error)
          this.mobileSocketWiring?.dispose()
          this.mobileSocketWiring = null
          if (error instanceof PinnedPortUnavailableError) {
            await socketTransport.stop().catch(() => {})
            throw error
          }
        }
      }
    }

    // Set live endpoint/token before metadata publication.
    this.activeTransports = activeTransports
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Without metadata CLI cannot discover runtime; close transports rather than serve invisibly.
      this.activeTransports = []
      this.transports = []
      await Promise.all(activeTransports.map((t) => t.stop().catch(() => {}))).catch(() => {})
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

  // Default to loopback until explicit network pairing or a connected network-reach grant; local-only browser grants must never trigger reconnect exposure (STA-2370).
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
        .some((device) => device.lastSeenAt > 0 && device.pairingReach !== 'this-computer') ?? false
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
      ...(options.fallbackPort !== undefined ? { fallbackPort: options.fallbackPort } : {}),
      ...(options.preferPinnedPort ? { preferPinnedPort: true } : {}),
      ...(options.requirePinnedPort ? { requirePinnedPort: true } : {}),
      fallbackLadder: wsFallbackPortLadder(this.wsPort)
    })
    const mobileSocketWiring = this.ensureMobileSocketWiring(deviceRegistry, e2eeKeypair)
    this.detachWebSocketWiring = mobileSocketWiring.attachTransport(wsTransport)

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

  // Direct/relay sockets share session wiring captured by brokers; swap transports within it during rebind or relay identity/binary/revocation state is lost.
  protected ensureMobileSocketWiring(
    deviceRegistry: DeviceRegistry,
    e2eeKeypair: E2EEKeypair
  ): MobileSocketWiring {
    if (this.mobileSocketWiring) {
      return this.mobileSocketWiring
    }
    // Allow one re-pair notification per session, including across rebinds.
    this.unpairedDeviceAuthThrottle = new UnpairedDeviceAuthThrottle({
      onTrigger: () => this.onUnpairedDeviceAuthFailure?.()
    })
    const mobileSocketWiring = new MobileSocketWiring({
      deviceRegistry,
      e2eeKeypair,
      onText: (socket, plaintext, reply, sendBinary) => {
        void this.trackClientRequest(() =>
          this.handleWebSocketMessage(
            plaintext,
            reply,
            sendBinary,
            undefined,
            socket.ws,
            socket.device.deviceToken ?? null,
            socket
          )
        )
      },
      onBinary: (socket, bytes) => {
        this.lastClientRequestAt = Date.now()
        this.handleWebSocketBinaryMessage(bytes, socket.ws)
      },
      onReady: (socket) => {
        this.mobileRelayPairingProvider?.onDemandStateChanged?.()
        if (socket.clientCapabilities.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY)) {
          this.runtime.noteAgentLaunchClientReady?.()
        }
        // Publish every live host terminal as a tab on attach.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          void placeUnshownLiveTerminalsBestEffort(this.runtime)
        }
        // Update capabilities once per socket; only phones send their own later update.
        if (socket.device.scope === 'runtime') {
          this.runtime.sidebarFacts?.noteRuntimeClient(
            socket.connectionId,
            socket.clientCapabilities
          )
        }
      },
      onClose: (socket, hasOtherConnections) => {
        if (!socket) {
          return
        }
        this.abortWebSocketDispatches(socket.ws)
        this.mobileDesktopRelay?.closePhoneConnection(socket.connectionId)
        // Stream cleanup is socket-scoped; disconnect state spans all transports for that device.
        this.runtime.cleanupSubscriptionsForConnection(socket.connectionId)
        this.runtime.cancelMobileDictationForConnection(socket.connectionId)
        this.binaryMessageRouter.deleteConnection(socket.connectionId)
        this.declaredDesktopClients.forget(socket.connectionId)
        if (!hasOtherConnections) {
          this.runtime.onClientDisconnected(socket.device.clientId)
        }
      },
      // Relay handles authorization upstream; only direct failures prompt local re-pairing.
      onUnpairedDeviceAuthFailure: (metadata) => {
        if (metadata.transport === 'direct') {
          this.unpairedDeviceAuthThrottle?.recordFailure()
        }
      }
    })
    this.mobileSocketWiring = mobileSocketWiring
    return mobileSocketWiring
  }
}
