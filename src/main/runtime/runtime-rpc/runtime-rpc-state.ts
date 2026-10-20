import { randomBytes } from 'node:crypto'
import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from '../rpc/dispatcher'
import { ALL_RPC_METHODS } from '../rpc/methods'
import type { RpcTransport } from '../rpc/transport'
import type { WebSocket } from 'ws'
import type { DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { RuntimeHostDescriptor } from '../../../shared/runtime-host-descriptor'
import type { UnpairedDeviceAuthThrottle } from '../rpc/unpaired-device-auth-throttle'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import type { MobileDesktopRelay } from '../mobile-desktop-relay/mobile-desktop-relay'
import type { MobileRelayHostCatalog } from '../mobile-desktop-relay/mobile-relay-host-catalog'
import { RelayRevokeOutbox } from '../mobile-cloud-relay/relay-revoke-outbox'
import { PushUnregisterOutbox } from '../push/push-unregister-outbox'
import { RuntimeBinaryMessageRouter } from '../runtime-binary-message-router'
import type { RuntimeMetadataOwnershipWatch } from '../runtime-metadata-ownership-watch'
import { RUNTIME_METADATA_OWNERSHIP_POLL_MS } from '../runtime-metadata-ownership-watch'
import { KEEPALIVE_INTERVAL_MS } from './runtime-rpc-long-poll'
import type {
  MobilePairingOffer,
  MobileRelayPairingProvider,
  OrcaRuntimeRpcServerOptions,
  PairingOfferUnavailable
} from './runtime-rpc-pairing-types'
import { DEFAULT_WS_PORT } from './runtime-rpc-pairing-types'

export class RuntimeRpcState {
  protected readonly runtime: OrcaRuntimeService
  protected readonly dispatcher: RpcDispatcher
  protected readonly userDataPath: string
  protected readonly pid: number
  protected readonly platform: NodeJS.Platform
  protected readonly enableWebSocket: boolean
  protected readonly wsPort: number
  protected readonly preferPinnedWsPort: boolean
  protected readonly requirePinnedWsPort: boolean
  protected readonly exposeNetworkByDefault: boolean
  protected readonly pinnedBindHost: string | null
  protected readonly webClientRoot: string | undefined
  // Why: STA-2370 — the host the WS listener is currently bound to, so pairing can widen loopback→all-interfaces once.
  protected wsBoundHost: string | null = null
  // Why: STA-2370 — in-flight widen so concurrent pairing requests share a single rebind.
  protected networkExposurePromise: Promise<void> | null = null
  // Why: STA-2370 — set by stop() so a racing pairing widen can't recreate a live wide listener into the
  // cleared transport arrays after shutdown; stop() also awaits any in-flight widen before snapshotting.
  protected stopping = false
  protected readonly authToken = randomBytes(24).toString('hex')
  protected readonly keepaliveIntervalMs: number
  protected readonly metadataOwnershipPollMs: number
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
  // Why: detaches the current WebSocketTransport from the session wiring so a pairing rebind can swap
  // transports under the SAME wiring (see ensureMobileSocketWiring) instead of orphaning relay sockets.
  protected detachWebSocketWiring: (() => void) | null = null
  protected mobileRelayPairingProvider: MobileRelayPairingProvider | null = null
  // Why nullable: launch sets both for every runtime process; in-process test servers may not.
  protected mobileDesktopRelay: MobileDesktopRelay | null = null
  protected mobileRelayHostCatalog: MobileRelayHostCatalog | null = null
  protected detachPairedServerRows: (() => void) | null = null
  // Why: lets an automatic mint install a provider whose launch-time construction failed.
  protected mobileRelayPairingProviderInstaller: (() => Promise<unknown>) | null = null
  protected mobileRelayPairingOfferQueue: Promise<void> = Promise.resolve()
  protected mobileRelayPairingOfferInFlight: {
    generation: number
    address: string | null
    rotate: boolean
    request: Promise<MobilePairingOffer>
  } | null = null
  protected mobilePairingOfferGeneration = 0
  protected onUnpairedDeviceAuthFailure: (() => void) | null = null
  protected unpairedDeviceAuthThrottle: UnpairedDeviceAuthThrottle | null = null
  protected readonly binaryMessageRouter = new RuntimeBinaryMessageRouter()
  protected readonly wsDispatchAbortStates = new Map<
    WebSocket,
    { controllers: Set<AbortController>; abortOnClose: () => void }
  >()
  protected clientRequestsInFlight = 0
  protected lastClientRequestAt = Date.now()

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
    webClientRoot,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    metadataOwnershipPollMs = RUNTIME_METADATA_OWNERSHIP_POLL_MS,
    methods
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.dispatcher = new RpcDispatcher({ runtime, methods: methods ?? ALL_RPC_METHODS })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.enableWebSocket = enableWebSocket
    this.wsPort = wsPort
    this.preferPinnedWsPort = preferPinnedWsPort
    this.requirePinnedWsPort = requirePinnedWsPort
    this.exposeNetworkByDefault = exposeNetworkByDefault
    this.pinnedBindHost = pinnedBindHost ?? null
    this.webClientRoot = webClientRoot
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.metadataOwnershipPollMs = metadataOwnershipPollMs
    this.relayRevokeOutbox = new RelayRevokeOutbox(userDataPath)
    this.pushUnregisterOutbox = new PushUnregisterOutbox(userDataPath)
    this.runtime.configureNotificationDismissalStore(userDataPath)
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
}
