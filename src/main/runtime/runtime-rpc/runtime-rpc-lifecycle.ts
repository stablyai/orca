import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'
import { watchRuntimeMetadataOwnership } from '../runtime-metadata-ownership-watch'
import type { RpcTransport } from '../rpc/transport'
import { UnixSocketTransport } from '../rpc/unix-socket-transport'
import { WebSocketTransport } from '../rpc/ws-transport'
import { readWsFallbackPort, writeWsFallbackPort } from '../rpc/ws-fallback-port-store'
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

export class RuntimeRpcLifecycle extends RuntimeRpcWebSocketDispatch {
  async start(): Promise<void> {
    if (this.activeTransports.length > 0) {
      return
    }

    // Why: SIGKILL/OOM skip stop(), orphaning `o-<pid>-*.sock` files; sweep them. Skipped on Windows: named pipes leave no filesystem entries.
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

    // Why: the `.catch` guarantees reply() always fires so a throw can't strand the client or leak the AbortController.
    socketTransport.onMessage((msg, reply, context) => {
      void this.handleMessage(msg, context)
        .then((response) => {
          reply(JSON.stringify(response))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          // Why: best-effort id recovery so the client can correlate the error frame to its pending request.
          let id = 'unknown'
          try {
            const parsed = JSON.parse(msg) as { id?: unknown }
            if (typeof parsed.id === 'string' && parsed.id.length > 0) {
              id = parsed.id
            }
          } catch {
            // ignore — fall through with id='unknown'
          }
          reply(JSON.stringify(this.buildError(id, 'internal_error', message)))
        })
    })

    await socketTransport.start()

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]

    // Why: WebSocket uses per-device tokens + E2EE (tweetnacl) instead of TLS since React Native can't pin self-signed certs.
    if (this.enableWebSocket) {
      // Why: land any deferred lastSeen write before a replacement registry reads the same file.
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
        try {
          const host = this.resolveInitialWebSocketBindHost()
          const { transport, endpoint } = await this.startWebSocketTransport({
            host,
            port: this.wsPort,
            preferPinnedPort: this.preferPinnedWsPort,
            // Why: stable fallback port across restarts keeps paired devices' endpoints valid (STA-1511); wsPort 0 = random (E2E).
            ...(this.wsPort !== 0 ? { fallbackPort: readWsFallbackPort(this.userDataPath) } : {})
          })
          if (this.wsPort !== 0 && transport.resolvedPort !== this.wsPort) {
            writeWsFallbackPort(this.userDataPath, transport.resolvedPort)
          }
          activeTransports.push(transport)
          transportsMeta.push({ kind: 'websocket', endpoint })
        } catch (error) {
          // Why: WebSocket transport is supplementary; on failure (e.g. port in use) continue with Unix socket only.
          console.error('[runtime] Failed to start WebSocket transport:', error)
          this.mobileSocketWiring = null
        }
      }
    }

    // Why: set in-memory transport state before writing metadata so the bootstrap file has the real endpoint/token pair.
    this.activeTransports = activeTransports
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that can't publish metadata is invisible to the CLI — close transports rather than run undiscoverable.
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
        // Why: never advertise endpoints we already tore down.
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

  // Why: STA-2370 — a desktop with no previously-connected device stays on loopback until the user
  // explicitly pairs; `orca serve`/E2E (exposeNetworkByDefault) and a reconnecting paired device bind wide.
  // A grant minted for "This computer only" is excluded: its client is a browser on this machine, so
  // counting it would republish the runtime on every interface one restart after the user declined that.
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

  // Why: builds and starts a WS transport bound to `host`, wiring the session-scoped mobile socket
  // handlers. Shared by initial start() and the pairing-time widen so both paths stay identical.
  protected async startWebSocketTransport(options: {
    host: string
    port: number
    preferPinnedPort: boolean
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
      ...(options.preferPinnedPort ? { preferPinnedPort: true } : {})
    })
    const mobileSocketWiring = this.ensureMobileSocketWiring(deviceRegistry, e2eeKeypair)
    this.detachWebSocketWiring = mobileSocketWiring.attachTransport(wsTransport)

    try {
      await wsTransport.start()
    } catch (error) {
      // Why: a listener that never bound must not stay attached to the session wiring (it would leak into
      // terminateDeviceConnections); detach before propagating so the wiring only tracks live transports.
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

  // Why: one MobileSocketWiring per server session. Direct WS and cloud relay both attach to it, and
  // DesktopRelayService captures it once at construction, so a loopback→wide pairing rebind must swap the
  // transport under the SAME wiring — replacing the wiring would strand relay sockets (lost connection IDs,
  // binary handling, and revocation targeting) on a dead object.
  protected ensureMobileSocketWiring(
    deviceRegistry: DeviceRegistry,
    e2eeKeypair: E2EEKeypair
  ): MobileSocketWiring {
    if (this.mobileSocketWiring) {
      return this.mobileSocketWiring
    }
    // Why: session-scoped so each desktop launch may notify once (a mid-session rebind must not reset it).
    this.unpairedDeviceAuthThrottle = new UnpairedDeviceAuthThrottle({
      onTrigger: () => this.onUnpairedDeviceAuthFailure?.()
    })
    const mobileSocketWiring = new MobileSocketWiring({
      deviceRegistry,
      e2eeKeypair,
      onText: (socket, plaintext, reply, sendBinary) => {
        void this.handleWebSocketMessage(
          plaintext,
          reply,
          sendBinary,
          undefined,
          socket.ws,
          socket.device.deviceToken,
          socket
        )
      },
      onBinary: (socket, bytes) => this.handleWebSocketBinaryMessage(bytes, socket.ws),
      onReady: () => {
        // Why: first authenticated mobile/remote client (direct WS and
        // cloud relay both attach here) starts path-candidate tracking.
        // Activation is a local-host concern: candidate buffers live on the
        // buffer-owning host's runtime, so a remote runtime proxy may
        // legitimately lack this method (its own server activates it).
        this.runtime.activateRecentPtyPathCandidateTracking?.()
        this.mobileRelayPairingProvider?.onDemandStateChanged?.()
      },
      onClose: (socket, hasOtherConnections) => {
        if (!socket) {
          return
        }
        this.abortWebSocketDispatches(socket.ws)
        // Why: subscriptions and binary streams are socket-scoped, but disconnect state is device-scoped across transports.
        this.runtime.cleanupSubscriptionsForConnection(socket.connectionId)
        this.runtime.cancelMobileDictationForConnection(socket.connectionId)
        this.binaryMessageRouter.deleteConnection(socket.connectionId)
        if (!hasOtherConnections) {
          this.runtime.onClientDisconnected(socket.device.deviceToken)
        }
      },
      // Why: relay attempts are authorized upstream; only direct failures should prompt local re-pairing.
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
