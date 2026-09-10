import type { DecodedFrame, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './protocol'
import { ClientRequestAborts } from './client-request-aborts'
import type { PtyConsumerCloseCause } from '../shared/pty-consumer-session-contract'
import {
  LegacyRelayPublicationLedger,
  type LegacyPublicationLease
} from './legacy-relay-publication-ledger'
import type {
  DispatcherClientWriter,
  RelayClientSinkOptions,
  RelayClientWrite,
  SinkWriteSettlement
} from './dispatcher-client-writer'
import type {
  MethodHandler,
  NotificationHandler,
  PendingRelayRequest,
  PreparedRelayFrame,
  PtyDataPublicationAdmission,
  RelayClient,
  RelayClientSessionIdentity,
  RelayClientSourceOptions
} from './dispatcher-contract'

export abstract class RelayDispatcherClientState {
  protected readonly primaryClient: RelayClient
  protected readonly clients = new Map<number, RelayClient>()
  protected requestHandlers = new Map<string, MethodHandler>()
  protected notificationHandlers = new Map<string, NotificationHandler>()
  protected readonly requestAborts = new ClientRequestAborts()
  protected readonly publicationLedger = new LegacyRelayPublicationLedger()
  protected pendingRelayRequests = new Map<number, PendingRelayRequest>()
  protected clientDetachListeners = new Set<
    (clientId: number, cause: PtyConsumerCloseCause) => void
  >()
  protected disposeListeners = new Set<() => void>()
  protected legacyCapacityListeners = new Set<() => void>()
  protected clientCapacityListeners = new Map<number, Set<() => void>>()
  protected ptyDataPublicationAdmission: PtyDataPublicationAdmission | null = null
  protected publicationTransactionDepth = 0
  protected deferredLegacyCapacity = false
  protected deferredForcedLegacyCapacity = false
  protected keepaliveTimer: ReturnType<typeof setInterval> | null = null
  protected disposed = false
  protected nextClientId = 1
  protected nextRequestId = 1

  constructor(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ) {
    this.primaryClient = this.createClient(write, sinkOptions, sessionIdentity, sourceOptions)
    this.clients.set(this.primaryClient.id, this.primaryClient)
    this.startKeepalive()
  }

  onRequest(method: string, handler: MethodHandler): void {
    this.requestHandlers.set(method, handler)
  }

  // Why it throws: this is a single slot, so a second registration silently shadows the
  // first and which one survives depends only on construction order. `pty.ackData` shipped
  // that way — a no-op handler was saved from disabling credit acks purely by the adapter
  // being constructed second (STA-4571). Fail loudly instead of encoding that ordering.
  onNotification(method: string, handler: NotificationHandler): void {
    if (this.notificationHandlers.has(method)) {
      throw new Error(`Notification handler for ${method} is already registered`)
    }
    this.notificationHandlers.set(method, handler)
  }

  onClientDetached(listener: (clientId: number, cause: PtyConsumerCloseCause) => void): () => void {
    this.clientDetachListeners.add(listener)
    return () => this.clientDetachListeners.delete(listener)
  }

  onDisposed(listener: () => void): () => void {
    this.disposeListeners.add(listener)
    return () => this.disposeListeners.delete(listener)
  }

  // Why single-slot rather than a listener set: admission is a veto, so two registrations would have
  // to agree on precedence. One owner (the PTY consumer session) holds it for the dispatcher's life.
  registerPtyDataPublicationAdmission(admission: PtyDataPublicationAdmission): () => void {
    if (this.ptyDataPublicationAdmission) {
      throw new Error('PTY data publication admission is already registered')
    }
    this.ptyDataPublicationAdmission = admission
    return () => {
      if (this.ptyDataPublicationAdmission === admission) {
        this.ptyDataPublicationAdmission = null
      }
    }
  }

  protected abstract createClient(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ): RelayClient
  protected abstract createWriter(
    client: RelayClient,
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions
  ): DispatcherClientWriter
  protected abstract handleFrame(client: RelayClient, frame: DecodedFrame): void
  protected abstract handleResponse(msg: JsonRpcResponse): void
  protected abstract handleRequest(client: RelayClient, req: JsonRpcRequest): Promise<void>
  protected abstract handleNotification(client: RelayClient, notif: JsonRpcNotification): void
  protected abstract startKeepalive(): void
  protected abstract notifyClientCapacity(clientId: number): void
  protected abstract notifyLegacyCapacity(force: boolean): void
  protected abstract enqueueLeasedFrame(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    lease: LegacyPublicationLease,
    onSettled?: (result: SinkWriteSettlement) => void
  ): boolean
}
