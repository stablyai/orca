import { randomBytes } from 'node:crypto'
import type { RuntimeTransportMetadata } from '../../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import {
  DEFAULT_LAZY_RPC_METHOD_GROUPS,
  EAGER_RPC_METHODS
} from '../methods/eager-rpc-method-registry'
import type { RpcTransport } from '../transport'
import type { WebSocket } from 'ws'
import type { DeviceRegistry } from './pairing/device-registry'
import { RuntimeClientConnectionLog } from './runtime-rpc-client-connection-log'
import type { E2EEKeypair } from './pairing/e2ee-keypair'
import type { RuntimeHostDescriptor } from '../../../../shared/remote-runtime/host-status/runtime-host-descriptor'
import type { UnpairedDeviceAuthThrottle } from '../mobile/unpaired-device-auth-throttle'
import type { AuthenticatedMobileSocket, MobileSocketWiring } from '../mobile/mobile-socket-wiring'
import {
  isIdleExemptControlMessage,
  isIdlePassiveControlSocket,
  isIdlePassiveSocket
} from '../mobile/mobile-socket-idle-passive'
import type { MobileDesktopRelay } from '../../mobile-desktop-relay/mobile-desktop-relay'
import type { MobileRelayHostCatalog } from '../../mobile-desktop-relay/mobile-relay-host-catalog'
import { RelayRevokeOutbox } from '../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import { PushUnregisterOutbox } from '../../push/push-unregister-outbox'
import { RuntimeBinaryMessageRouter } from './runtime-binary-message-router'
import { eraseRpcMethods, isStreamingMethod, type RpcResponse } from '../core'
import { errorResponse } from '../responses/rpc-response'
import {
  RUNTIME_IDLE_STOPPED_ERROR_CODE,
  RUNTIME_IDLE_STOPPED_MESSAGE
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-stop-signal'

import {
  type RuntimeMetadataOwnershipWatch,
  RUNTIME_METADATA_OWNERSHIP_POLL_MS
} from './runtime-metadata-ownership-watch'
import {
  ASK_LONG_POLL_SHARE,
  BROWSER_HOST_LONG_POLL_SHARE,
  KEEPALIVE_INTERVAL_MS,
  LONG_POLL_CAP,
  SPECIALIZED_LONG_POLL_SHARE
} from './runtime-rpc-long-poll'

import {
  type MobilePairingOffer,
  type MobileRelayPairingProvider,
  type OrcaRuntimeRpcServerOptions,
  type PairingOfferUnavailable,
  DEFAULT_WS_PORT
} from './runtime-rpc-pairing-types'
import { DeclaredDesktopClients } from './pairing/declared-desktop-clients'
import { AuthenticatedSourceRecorder } from './network-source-policy-store'
import type { ServeNetworkSourceOptions } from './serve-network-source-policy'
import type { WebSocketSourceGuard } from '../transports/websocket/source-admission/ws-network-source-guard'

export class RuntimeRpcState {
  protected readonly runtime: OrcaRuntimeService
  protected readonly dispatcher: RpcDispatcher
  protected readonly streamingMethods: ReadonlySet<string>
  protected readonly userDataPath: string
  protected readonly pid: number
  protected readonly platform: NodeJS.Platform
  protected readonly enableWebSocket: boolean
  protected readonly wsPort: number
  protected readonly preferPinnedWsPort: boolean
  protected readonly requirePinnedWsPort: boolean
  protected readonly exposeNetworkByDefault: boolean
  protected readonly pinnedBindHost: string | null
  protected readonly serveNetworkSources: ServeNetworkSourceOptions | null
  protected webSocketSourceGuard: WebSocketSourceGuard | null = null
  protected readonly webClientRoot: string | undefined
  // Track actual WS bind host for pairing exposure transitions (STA-2370).
  protected wsBoundHost: string | null = null
  // Share one pending rebind across concurrent pairing offers (STA-2370).
  protected networkExposurePromise: Promise<void> | null = null
  // Stop fences new exposure and waits pending rebind before taking transport snapshots (STA-2370).
  protected stopping = false
  protected readonly authToken = randomBytes(24).toString('hex')
  protected readonly keepaliveIntervalMs: number
  protected readonly longPollCap: number
  protected readonly metadataOwnershipPollMs: number
  protected readonly askLongPollCap: number
  protected readonly browserHostLongPollCap: number
  protected readonly browserHostLongPollCapPerDevice: number
  protected readonly specializedLongPollCap: number
  protected readonly relayRevokeOutbox: RelayRevokeOutbox
  protected readonly pushUnregisterOutbox: PushUnregisterOutbox
  protected deviceRegistry: DeviceRegistry | null = null
  protected e2eeKeypair: E2EEKeypair | null = null
  protected hostDescriptor: RuntimeHostDescriptor | null = null
  protected pairingInitializationFailure: PairingOfferUnavailable | null = null
  protected activeTransports: RpcTransport[] = []
  protected transports: RuntimeTransportMetadata[] = []
  protected metadataOwnershipWatch: RuntimeMetadataOwnershipWatch | null = null
  protected mobileSocketWiring: MobileSocketWiring | null = null
  protected clientConnectionLog: RuntimeClientConnectionLog | null = null
  // Rebind swaps transports inside session wiring so captured relay sockets remain attached.
  protected detachWebSocketWiring: (() => void) | null = null
  protected mobileRelayPairingProvider: MobileRelayPairingProvider | null = null
  // Why nullable: launch sets both for every runtime process; in-process test servers may not.
  protected mobileDesktopRelay: MobileDesktopRelay | null = null
  protected mobileRelayHostCatalog: MobileRelayHostCatalog | null = null
  protected detachPairedServerRows: (() => void) | null = null
  protected detachRelayHostsChanges: (() => void) | null = null
  protected readonly declaredDesktopClients = new DeclaredDesktopClients()
  protected readonly authenticatedSourceRecorder: AuthenticatedSourceRecorder
  // Why: lets an automatic mint install a provider whose launch-time construction failed.
  protected mobileRelayPairingProviderInstaller: (() => Promise<unknown>) | null = null
  protected mobileRelayPairingOfferQueue: Promise<void> = Promise.resolve()
  protected mobileRelayPairingOfferInFlight: {
    generation: number
    createdByDeviceId: string | undefined
    address: string | null
    rotate: boolean
    request: Promise<MobilePairingOffer>
  } | null = null
  protected mobilePairingOfferGeneration = 0
  protected onUnpairedDeviceAuthFailure: (() => void) | null = null
  protected onPairedDevicesChanged: (() => void) | null = null
  protected unpairedDeviceAuthThrottle: UnpairedDeviceAuthThrottle | null = null
  protected readonly binaryMessageRouter = new RuntimeBinaryMessageRouter()
  protected readonly wsDispatchAbortStates = new Map<
    WebSocket,
    { controllers: Set<AbortController>; abortOnClose: () => void }
  >()
  // Count long-running dispatches separately from socket maxConnections (design §§3.1, 7).
  protected activeLongPolls = 0
  // Why: subset of activeLongPolls held by orchestration.ask, fenced by askLongPollCap.
  protected activeAskLongPolls = 0
  protected activeBrowserHostLongPolls = 0
  protected readonly activeBrowserHostLongPollsByDevice = new Map<string, number>()
  protected clientRequestsInFlight = 0
  protected lastClientRequestAt = Date.now()
  // Set once an idle stop commits: from then on no client message is dispatched.
  protected idleStopFenced = false

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    enableWebSocket = false,
    wsPort = DEFAULT_WS_PORT,
    preferPinnedWsPort = false,
    requirePinnedWsPort = false,
    exposeNetworkByDefault = false,
    pinnedBindHost,
    serveNetworkSources,
    webClientRoot,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    longPollCap = LONG_POLL_CAP,
    metadataOwnershipPollMs = RUNTIME_METADATA_OWNERSHIP_POLL_MS,
    methods
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    const registeredMethods = methods ?? EAGER_RPC_METHODS
    const lazyGroups = methods ? [] : DEFAULT_LAZY_RPC_METHOD_GROUPS
    this.dispatcher = new RpcDispatcher({ runtime, methods: registeredMethods, lazyGroups })
    // By declaration, so every subscription, current or future, is classified the same way.
    this.streamingMethods = new Set([
      ...eraseRpcMethods(registeredMethods)
        .filter(isStreamingMethod)
        .map((method) => method.name),
      ...lazyGroups.flatMap((group) => group.streamingNames ?? [])
    ])
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.enableWebSocket = enableWebSocket
    this.wsPort = wsPort
    this.preferPinnedWsPort = preferPinnedWsPort
    this.requirePinnedWsPort = requirePinnedWsPort
    this.exposeNetworkByDefault = exposeNetworkByDefault
    this.pinnedBindHost = pinnedBindHost ?? null
    this.serveNetworkSources = serveNetworkSources ?? null
    this.webClientRoot = webClientRoot
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.longPollCap = longPollCap
    this.metadataOwnershipPollMs = metadataOwnershipPollMs
    // Derive reservation from any caller-selected cap; do not make it independently configurable.
    this.askLongPollCap = Math.max(1, Math.floor(longPollCap * ASK_LONG_POLL_SHARE))
    this.browserHostLongPollCap = Math.max(
      1,
      Math.floor(longPollCap * BROWSER_HOST_LONG_POLL_SHARE)
    )
    this.browserHostLongPollCapPerDevice = Math.max(1, Math.floor(this.browserHostLongPollCap / 2))
    this.specializedLongPollCap = Math.max(1, Math.floor(longPollCap * SPECIALIZED_LONG_POLL_SHARE))
    this.relayRevokeOutbox = new RelayRevokeOutbox(userDataPath)
    this.pushUnregisterOutbox = new PushUnregisterOutbox(userDataPath)
    this.authenticatedSourceRecorder = new AuthenticatedSourceRecorder(userDataPath)
    this.runtime.configureNotificationDismissalStore(userDataPath)
  }

  /** A passive watcher's requests are not use either, or opening one would reset the idle clock.
   *  A passive control socket's are, except its heartbeat, declarations and streams. */
  protected trackSocketRequest(
    socket: Pick<AuthenticatedMobileSocket, 'clientCapabilities'>,
    plaintext: string,
    reply: (response: string) => void,
    work: () => Promise<void>
  ): Promise<void> {
    if (this.idleStopFenced) {
      reply(JSON.stringify(this.idleStopRefusal(plaintext)))
      return Promise.resolve()
    }
    if (
      isIdlePassiveSocket(socket) ||
      (isIdlePassiveControlSocket(socket) &&
        isIdleExemptControlMessage(plaintext, (method) => this.streamingMethods.has(method)))
    ) {
      return work()
    }
    return this.trackClientRequest(work)
  }

  /** The answer to a message that arrived after an idle stop fenced admission; never dispatched. */
  protected idleStopRefusal(rawMessage: string): RpcResponse {
    let id = 'unknown'
    try {
      const parsed: unknown = JSON.parse(rawMessage)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'id' in parsed &&
        typeof parsed.id === 'string' &&
        parsed.id.length > 0
      ) {
        id = parsed.id
      }
    } catch {}
    const meta = { runtimeId: this.runtime.getRuntimeId() }
    return errorResponse(id, meta, RUNTIME_IDLE_STOPPED_ERROR_CODE, RUNTIME_IDLE_STOPPED_MESSAGE)
  }

  /** Counts a client message for idle exit, from receipt until its dispatch settles. */
  protected trackClientRequest<T>(work: () => Promise<T>): Promise<T> {
    this.clientRequestsInFlight += 1
    this.lastClientRequestAt = Date.now()
    return work().finally(() => {
      this.clientRequestsInFlight -= 1
      this.lastClientRequestAt = Date.now()
    })
  }

  /** One log per socket wiring: a relay close that lands after stop must not touch a later session's counts. */
  protected startClientConnectionLog(): RuntimeClientConnectionLog {
    this.clientConnectionLog?.close()
    this.clientConnectionLog = new RuntimeClientConnectionLog()
    return this.clientConnectionLog
  }
}
