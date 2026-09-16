import type {
  FrameDecoder,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PreparedJsonRpcPayload
} from './protocol'
import type { DispatcherClientWriter, SinkWriteSettlement } from './dispatcher-client-writer'

export type RequestContext = {
  clientId: number
  isStale: () => boolean
  signal?: AbortSignal
  sessionIdentity?: RelayClientSessionIdentity
  onResponseSettled?: (handler: (result: SinkWriteSettlement) => void) => void
}

export type RelayClientSessionIdentity = {
  principal: string
  authenticated: boolean
  allowSessionOwner: boolean
  authenticationKind: 'unproved' | 'launch-nonce' | 'endpoint-credential'
}

export type RelayClientSourceOptions = {
  pauseReads?: () => void
  resumeReads?: () => void
}

export type PtyDataPublicationAdmission = (
  clientId: number,
  params: Readonly<Record<string, unknown>>
) => boolean

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

export type DroppedProducerNotificationLog = {
  generation: number
  loggedKeys: Set<string>
}

export type RelayClient = {
  id: number
  decoder: FrameDecoder
  writer: DispatcherClientWriter
  bulkChain: Promise<void>
  nextOutgoingSeq: number
  highestReceivedSeq: number
  // Why: a client that never frames anything has no staleness to measure, so the silence window
  // cannot see it. Its attach time is the only clock it has.
  attachedAt: number
  // Why: the relay had no inbound-liveness signal at all, so a half-open client was never reaped
  // and kept its owner lease and paused PTYs indefinitely.
  lastReceivedAt: number | null
  // Why silence is only held against a client that sends keepalives: not every client speaks that
  // protocol. The remote `orca` CLI opens the socket, sends one `orca.cli` request and then waits
  // for a result that is deliberately budgeted in minutes (src/relay/remote-cli-timeout.ts), so
  // judging it on inbound silence would kill `terminal wait`, `--wait` and `orchestration ask`
  // after 20s. Only a client that has proven it participates is eligible.
  keepaliveObserved: boolean
  generation: number
  closed: boolean
  droppedNotificationLog: DroppedProducerNotificationLog | null
  sessionIdentity: RelayClientSessionIdentity
}

export type OutgoingJsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export type PreparedRelayFrame = Readonly<{
  payload: PreparedJsonRpcPayload
  frameBytes: number
  ptyDataAdmissionParams: Readonly<Record<string, unknown>> | null
}>

export type PendingRelayRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Why: the log key set is rebuilt per generation, but a producer minting synthetic method names would still
// grow it inside one generation — cap it well above the fixed relay method vocabulary.
export const DROPPED_NOTIFICATION_LOG_KEY_LIMIT = 64

export const RESPONSE_OVER_CAPACITY_MESSAGE =
  'Relay response exceeded the bounded transport capacity'

export const RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS = 30_000
