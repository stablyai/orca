import { randomBytes } from 'node:crypto'
import type { RuntimeTransportMetadata } from '../../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from '../rpc/dispatcher'
import { ALL_RPC_METHODS } from '../rpc/methods'
import type { RpcTransport } from '../rpc/transport'
import type { WebSocket } from 'ws'
import type { DeviceRegistry } from '../device-registry'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { UnpairedDeviceAuthThrottle } from '../rpc/unpaired-device-auth-throttle'
import type { MobileSocketWiring } from '../rpc/mobile-socket-wiring'
import { RelayRevokeOutbox } from '../relay/relay-revoke-outbox'
import { RuntimeBinaryMessageRouter } from '../runtime-binary-message-router'
import type { RuntimeMetadataOwnershipWatch } from '../runtime-metadata-ownership-watch'
import { RUNTIME_METADATA_OWNERSHIP_POLL_MS } from '../runtime-metadata-ownership-watch'
import {
  ASK_LONG_POLL_SHARE,
  BROWSER_HOST_LONG_POLL_SHARE,
  KEEPALIVE_INTERVAL_MS,
  LONG_POLL_CAP,
  SPECIALIZED_LONG_POLL_SHARE
} from './runtime-rpc-long-poll'
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
  protected readonly longPollCap: number
  protected readonly metadataOwnershipPollMs: number
  protected readonly askLongPollCap: number
  protected readonly browserHostLongPollCap: number
  protected readonly browserHostLongPollCapPerDevice: number
  protected readonly specializedLongPollCap: number
  protected readonly relayRevokeOutbox: RelayRevokeOutbox
  protected deviceRegistry: DeviceRegistry | null = null
  protected e2eeKeypair: E2EEKeypair | null = null
  protected pairingInitializationFailure: PairingOfferUnavailable | null = null
  protected tlsFingerprint: string | null = null
  protected activeTransports: RpcTransport[] = []
  protected transports: RuntimeTransportMetadata[] = []
  protected metadataOwnershipWatch: RuntimeMetadataOwnershipWatch | null = null
  protected mobileSocketWiring: MobileSocketWiring | null = null
  // Why: detaches the current WebSocketTransport from the session wiring so a pairing rebind can swap
  // transports under the SAME wiring (see ensureMobileSocketWiring) instead of orphaning relay sockets.
  protected detachWebSocketWiring: (() => void) | null = null
  protected mobileRelayPairingProvider: MobileRelayPairingProvider | null = null
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
  // Why: separate from server.maxConnections — count only long-running dispatches, not short RPCs. See §3.1 + §7 risk #2.
  protected activeLongPolls = 0
  // Why: subset of activeLongPolls held by orchestration.ask, fenced by askLongPollCap.
  protected activeAskLongPolls = 0
  protected activeBrowserHostLongPolls = 0
  protected readonly activeBrowserHostLongPollsByDevice = new Map<string, number>()

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    enableWebSocket = false,
    wsPort = DEFAULT_WS_PORT,
    preferPinnedWsPort = false,
    exposeNetworkByDefault = false,
    pinnedBindHost,
    webClientRoot,
    keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    longPollCap = LONG_POLL_CAP,
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
    this.exposeNetworkByDefault = exposeNetworkByDefault
    this.pinnedBindHost = pinnedBindHost ?? null
    this.webClientRoot = webClientRoot
    this.keepaliveIntervalMs = keepaliveIntervalMs
    this.longPollCap = longPollCap
    this.metadataOwnershipPollMs = metadataOwnershipPollMs
    // Why: derived, not configurable — the reservation must hold for whatever cap a caller picks.
    this.askLongPollCap = Math.max(1, Math.floor(longPollCap * ASK_LONG_POLL_SHARE))
    this.browserHostLongPollCap = Math.max(
      1,
      Math.floor(longPollCap * BROWSER_HOST_LONG_POLL_SHARE)
    )
    this.browserHostLongPollCapPerDevice = Math.max(1, Math.floor(this.browserHostLongPollCap / 2))
    this.specializedLongPollCap = Math.max(1, Math.floor(longPollCap * SPECIALIZED_LONG_POLL_SHARE))
    this.relayRevokeOutbox = new RelayRevokeOutbox(userDataPath)
  }
}
