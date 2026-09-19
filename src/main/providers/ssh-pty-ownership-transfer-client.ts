import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS,
  PTY_OWNERSHIP_TRANSFER_METHODS,
  type PtyOwnershipTransferAbortRequest,
  type PtyOwnershipTransferAbortResult,
  type PtyOwnershipTransferCommitRequest,
  type PtyOwnershipTransferCommitResult,
  type PtyOwnershipTransferInputRequest,
  type PtyOwnershipTransferInputResult,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferPrepareResult,
  type PtyOwnershipTransferPublishRequest,
  type PtyOwnershipTransferPublishResult,
  type PtyOwnershipTransferReplayRequest,
  type PtyOwnershipTransferReplayResult,
  type PtyOwnershipTransferRetireInputRequest,
  type PtyOwnershipTransferRetireInputResult,
  type PtyOwnershipTransferStatusRequest,
  type PtyOwnershipTransferStatusResult,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import {
  parsePtyOwnershipTransferAttachmentResult,
  parsePtyOwnershipTransferControlResult,
  parsePtyOwnershipTransferExitEvent,
  type PtyOwnershipTransferAttachmentRequest,
  type PtyOwnershipTransferAttachmentResult,
  type PtyOwnershipTransferControlRequest,
  type PtyOwnershipTransferControlResult,
  type PtyOwnershipTransferExitEvent
} from '../../shared/pty-ownership-transfer-control-wire'
import {
  parsePtyOwnershipTransferAbortResult,
  parsePtyOwnershipTransferCommitResult,
  parsePtyOwnershipTransferInputResult,
  parsePtyOwnershipTransferPrepareResult,
  parsePtyOwnershipTransferPublishResult,
  parsePtyOwnershipTransferReplayResult,
  parsePtyOwnershipTransferRetireInputResult,
  parsePtyOwnershipTransferStatusResult
} from '../../shared/pty-ownership-transfer-wire-results'
import {
  parsePtyOwnershipTransferReconnectRekeyResult,
  type PtyOwnershipTransferReconnectRekeyRequest,
  type PtyOwnershipTransferReconnectRekeyResult
} from '../../shared/pty-ownership-transfer-reconnect-rekey-wire'

export type PtyOwnershipTransferRequestOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: number
}>

export type PtyOwnershipTransferRequestTransport = (
  method: string,
  params: object,
  options?: PtyOwnershipTransferRequestOptions
) => Promise<unknown>

/** Strict transport-independent client for the additive unary transfer RPC surface. */
export class PtyOwnershipTransferRequestClient {
  constructor(private readonly requestTransport: PtyOwnershipTransferRequestTransport) {}

  async prepare(
    request: PtyOwnershipTransferPrepareRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferPrepareResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.prepare,
      request,
      parsePtyOwnershipTransferPrepareResult,
      options
    )
  }

  async replay(
    request: PtyOwnershipTransferReplayRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferReplayResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.replay,
      request,
      parsePtyOwnershipTransferReplayResult,
      options
    )
  }

  async commit(
    request: PtyOwnershipTransferCommitRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferCommitResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.commit,
      request,
      parsePtyOwnershipTransferCommitResult,
      options
    )
  }

  async publish(
    request: PtyOwnershipTransferPublishRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferPublishResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.publish,
      request,
      parsePtyOwnershipTransferPublishResult,
      options
    )
  }

  async status(
    request: PtyOwnershipTransferStatusRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferStatusResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.status,
      request,
      parsePtyOwnershipTransferStatusResult,
      options
    )
  }

  async input(
    request: PtyOwnershipTransferInputRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferInputResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.input,
      request,
      parsePtyOwnershipTransferInputResult,
      options
    )
  }

  async retireInput(
    request: PtyOwnershipTransferRetireInputRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferRetireInputResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.retireInput,
      request,
      parsePtyOwnershipTransferRetireInputResult,
      options
    )
  }

  async abort(
    request: PtyOwnershipTransferAbortRequest,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferAbortResult> {
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.abort,
      request,
      parsePtyOwnershipTransferAbortResult,
      options
    )
  }

  async attachDestination(
    request: PtyOwnershipTransferAttachmentRequest,
    capabilities: PtyOwnershipBridgeCapabilities,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferAttachmentResult> {
    assertDestinationRoutingCapability(capabilities)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.attach,
      request,
      parsePtyOwnershipTransferAttachmentResult,
      options
    )
  }

  async rekeyReconnect(
    request: PtyOwnershipTransferReconnectRekeyRequest,
    capabilities: PtyOwnershipBridgeCapabilities,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferReconnectRekeyResult> {
    assertReconnectRekeyCapability(capabilities)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect,
      request,
      parsePtyOwnershipTransferReconnectRekeyResult,
      options
    )
  }

  async controlDestination(
    request: PtyOwnershipTransferControlRequest,
    capabilities: PtyOwnershipBridgeCapabilities,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<PtyOwnershipTransferControlResult> {
    assertDestinationRoutingCapability(capabilities)
    return this.request(
      PTY_OWNERSHIP_TRANSFER_METHODS.control,
      request,
      parsePtyOwnershipTransferControlResult,
      options
    )
  }

  private async request<T>(
    method: string,
    request: object,
    parse: (value: unknown) => T,
    options?: PtyOwnershipTransferRequestOptions
  ): Promise<T> {
    const response = await this.requestTransport(method, { ...request }, options)
    const parsed = parse(response)
    assertResponseIdentity(parsed, request)
    return parsed
  }
}

/** SSH binding adds authoritative exit and transport-loss streams to the unary client. */
export class SshPtyOwnershipTransferClient extends PtyOwnershipTransferRequestClient {
  constructor(private readonly mux: SshChannelMultiplexer) {
    super((method, params, options) =>
      mux.request(method, params as Record<string, unknown>, options)
    )
  }

  onDestinationExit(
    capabilities: PtyOwnershipBridgeCapabilities,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ): () => void {
    assertDestinationRoutingCapability(capabilities)
    return this.mux.onNotificationByMethod(PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS.exit, (value) => {
      try {
        callback(parsePtyOwnershipTransferExitEvent(value))
      } catch {
        // Untrusted or mixed-version notifications do not establish exit authority.
      }
    })
  }

  onDestinationExitForAttachment(
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ): () => void {
    assertDestinationRoutingCapability(capabilities)
    return this.mux.onNotificationByMethod(PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS.exit, (value) => {
      try {
        const event = parsePtyOwnershipTransferExitEvent(value)
        if (
          event.attachmentId !== attachmentId ||
          event.bridgeId !== identity.bridgeId ||
          event.terminalId !== identity.terminalId ||
          event.incarnationId !== identity.incarnationId ||
          event.ownerLease !== identity.ownerLease ||
          event.sourceOwnerGeneration !== identity.sourceOwnerGeneration ||
          event.destinationRuntimeId !== identity.destinationRuntimeId
        ) {
          return
        }
        callback(event)
      } catch {
        // Untrusted or mixed-version notifications do not establish exit authority.
      }
    })
  }

  onTransportLost(callback: () => void): () => void {
    return this.mux.onDispose(() => callback())
  }
}

function assertDestinationRoutingCapability(capabilities: PtyOwnershipBridgeCapabilities): void {
  if (
    !capabilities.liveTransfer ||
    !capabilities.destinationOutput ||
    !capabilities.destinationControl ||
    !capabilities.authoritativeExit
  ) {
    throw new Error('pty_ownership_transfer_destination_routing_unsupported')
  }
}

function assertReconnectRekeyCapability(capabilities: PtyOwnershipBridgeCapabilities): void {
  assertDestinationRoutingCapability(capabilities)
  if (!capabilities.postCommitReplay || !capabilities.reconnectRekey) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_unsupported')
  }
}

function assertResponseIdentity(response: unknown, request: object): void {
  if (!isRecord(response) || !isRecord(request) || typeof response.bridgeId !== 'string') {
    return
  }
  for (const field of [
    'bridgeId',
    'terminalId',
    'incarnationId',
    'ownerLease',
    'sourceOwnerGeneration',
    'destinationRuntimeId',
    'attachmentId',
    'previousReconnectGeneration',
    'reconnectGeneration',
    'controlId'
  ]) {
    if (field in request && response[field] !== request[field]) {
      throw new Error('pty_ownership_transfer_response_identity_mismatch')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
