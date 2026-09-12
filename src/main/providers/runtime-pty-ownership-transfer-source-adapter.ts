import { RuntimePtyOwnershipTransferOutputCredit } from './runtime-pty-ownership-transfer-output-credit'
import {
  requestContext,
  type RuntimePtyOwnershipTransferAttachmentBinding
} from './runtime-pty-ownership-transfer-attachment-binding'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import {
  PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION,
  PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES
} from '../../shared/pty-ownership-bridge-contract'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  type PtyOwnershipTransferSourceStreamRequest,
  type PtyOwnershipTransferAbortRequest,
  type PtyOwnershipTransferAttachmentRequest,
  type PtyOwnershipTransferCommitRequest,
  type PtyOwnershipTransferControlRequest,
  type PtyOwnershipTransferInputRequest,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferPublishRequest,
  type PtyOwnershipTransferReplayRequest,
  type PtyOwnershipTransferRetireInputRequest,
  type PtyOwnershipTransferStatusRequest,
  type PtyOwnershipTransferOutputAcknowledgementRequest,
  type PtyOwnershipTransferOutputAcknowledgementResult
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferReconnectRekeyRequest } from '../../shared/pty-ownership-transfer-reconnect-rekey-wire'
import type { PtyOwnershipTransferOutputFragment } from '../../shared/pty-ownership-transfer-output-envelope'
import type {
  PtyOwnershipTransferExitEvent,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import {
  RelayPtyOwnershipTransferAdapter,
  type RelayPtyOwnershipTransferAdapterOptions,
  type RelayPtyOwnershipTransferSnapshot
} from '../../relay/relay-pty-ownership-transfer-adapter'

export type { RuntimePtyOwnershipTransferAttachmentBinding } from './runtime-pty-ownership-transfer-attachment-binding'

export type RuntimePtyOwnershipTransferSourceAdapterOptions = Omit<
  RelayPtyOwnershipTransferAdapterOptions,
  'authorizeRequest' | 'publishDestinationOutput' | 'publishDestinationExit'
> &
  Readonly<{
    mutationEnabled?: () => boolean
    authorizeMutationRequest?: (
      method: string,
      request: unknown,
      binding: RuntimePtyOwnershipTransferAttachmentBinding
    ) => boolean
    publishDestinationOutput?: RelayPtyOwnershipTransferAdapterOptions['publishDestinationOutput']
    publishDestinationExit?: RelayPtyOwnershipTransferAdapterOptions['publishDestinationExit']
  }>

export type RuntimePtyOwnershipTransferOutputObservation = Readonly<{
  terminalId: string
  incarnationId: string
  data: string
  emissionKey?: string
}>

export type RuntimePtyOwnershipTransferOutputEvent = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  attachmentId: string
  frame: PtyOwnershipTransferOutputFrame
}>

/** Host-local ownership source using the same durable state machine as direct SSH relays. */
export class RuntimePtyOwnershipTransferSourceAdapter {
  private readonly adapter: RelayPtyOwnershipTransferAdapter
  private readonly capabilities: PtyOwnershipBridgeCapabilities
  private readonly mutationEnabled: () => boolean
  private readonly authorizeMutationRequest:
    | RuntimePtyOwnershipTransferSourceAdapterOptions['authorizeMutationRequest']
    | undefined
  private readonly routesComplete: boolean
  private readonly resolveSource: RuntimePtyOwnershipTransferSourceAdapterOptions['resolveSource']
  private readonly observedIncarnations = new Map<string, string>()
  private readonly outputListeners = new Set<
    (event: RuntimePtyOwnershipTransferOutputEvent) => void
  >()
  private readonly exitListeners = new Set<(event: PtyOwnershipTransferExitEvent) => void>()
  private readonly outputCredit: RuntimePtyOwnershipTransferOutputCredit

  constructor(options: RuntimePtyOwnershipTransferSourceAdapterOptions) {
    const { mutationEnabled, ...adapterOptions } = options
    const destinationOutput = options.publishDestinationOutput !== undefined
    const destinationControl = options.applyDestinationControl !== undefined
    const authoritativeExit = options.publishDestinationExit !== undefined
    this.routesComplete =
      options.store !== undefined && destinationOutput && destinationControl && authoritativeExit
    this.mutationEnabled = mutationEnabled ?? (() => false)
    this.authorizeMutationRequest = options.authorizeMutationRequest
    this.resolveSource = options.resolveSource
    this.capabilities = Object.freeze({
      protocolVersions: Object.freeze([PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION]),
      maxReplayBytes: options.replayBytes ?? PTY_OWNERSHIP_BRIDGE_DEFAULT_REPLAY_BYTES,
      maxInputIds: options.inputIds ?? PTY_OWNERSHIP_BRIDGE_DEFAULT_INPUT_IDS,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: false,
      statusQuery: true,
      ...(destinationOutput ? { destinationOutput: true } : {}),
      ...(destinationControl ? { destinationControl: true } : {}),
      ...(authoritativeExit ? { authoritativeExit: true } : {}),
      ...(this.routesComplete ? { postCommitReplay: true, reconnectRekey: true } : {})
    })
    this.adapter = new RelayPtyOwnershipTransferAdapter({
      ...adapterOptions,
      authorizeRequest: () => false,
      publishDestinationOutput: (identity, attachmentId, frame) => {
        options.publishDestinationOutput?.(identity, attachmentId, frame)
        const event = Object.freeze({
          identity: Object.freeze({ ...identity }),
          attachmentId,
          frame: Object.freeze({ ...frame })
        })
        for (const listener of this.outputListeners) {
          try {
            listener(event)
          } catch {
            // A disconnected paired stream must not break source journaling.
          }
        }
      },
      publishDestinationExit: (event, binding) => {
        options.publishDestinationExit?.(event, binding)
        for (const listener of this.exitListeners) {
          try {
            listener(event)
          } catch {
            // A disconnected paired stream must not break source journaling.
          }
        }
      }
    })
    this.outputCredit = new RuntimePtyOwnershipTransferOutputCredit(this.adapter)
  }

  onDestinationOutput(
    listener: (event: RuntimePtyOwnershipTransferOutputEvent) => void
  ): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  onDestinationExit(listener: (event: PtyOwnershipTransferExitEvent) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Register the authenticated stream callback used by cumulative output ACKs. */
  onDestinationOutputAcknowledgement(
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    binding: RuntimePtyOwnershipTransferAttachmentBinding,
    acknowledge: (throughSeq: number) => void
  ): () => void {
    return this.outputCredit.register(identity, attachmentId, binding, acknowledge)
  }

  /** Deliver a cumulative output ACK only to the matching live authenticated stream. */
  acknowledgeDestinationOutput(
    request: PtyOwnershipTransferOutputAcknowledgementRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): PtyOwnershipTransferOutputAcknowledgementResult {
    this.assertMutationAuthorized(
      PTY_OWNERSHIP_TRANSFER_METHODS.acknowledgeOutput,
      request,
      binding
    )
    return this.outputCredit.acknowledge(request, binding)
  }

  getCapabilities(): PtyOwnershipBridgeCapabilities {
    return Object.freeze({
      ...this.capabilities,
      liveTransfer:
        this.routesComplete && this.authorizeMutationRequest !== undefined && this.mutationEnabled()
    })
  }

  prepare(
    request: PtyOwnershipTransferPrepareRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, request, binding)
    return this.adapter.prepare(request)
  }

  replay(
    request: PtyOwnershipTransferReplayRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.replay, request, binding)
    return this.adapter.replay(request, requestContext(binding))
  }

  commit(
    request: PtyOwnershipTransferCommitRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.commit, request, binding)
    return this.adapter.commit(request)
  }

  publish(
    request: PtyOwnershipTransferPublishRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.publish, request, binding)
    return this.adapter.publish(request)
  }

  status(request: PtyOwnershipTransferStatusRequest) {
    return this.adapter.status(request)
  }

  acceptInput(
    request: PtyOwnershipTransferInputRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.input, request, binding)
    return this.adapter.acceptInput(request)
  }

  retireInput(
    request: PtyOwnershipTransferRetireInputRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.retireInput, request, binding)
    return this.adapter.retireInput(request)
  }

  attachDestination(
    request: PtyOwnershipTransferAttachmentRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.attach, request, binding)
    return this.adapter.attach(request, requestContext(binding))
  }

  rekeyReconnect(
    request: PtyOwnershipTransferReconnectRekeyRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect, request, binding)
    return this.adapter.rekeyReconnect(request, requestContext(binding))
  }

  /** Authorize the attachment-scoped source stream before exposing PTY output. */
  assertStreamAuthorized(
    request: PtyOwnershipTransferSourceStreamRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): void {
    this.assertMutationAuthorized('pty.ownershipTransfer.streamSource', request, binding)
  }

  controlDestination(
    request: PtyOwnershipTransferControlRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.control, request, binding)
    return this.adapter.control(request, requestContext(binding))
  }

  abort(
    request: PtyOwnershipTransferAbortRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) {
    this.assertMutationAuthorized(PTY_OWNERSHIP_TRANSFER_METHODS.abort, request, binding)
    return this.adapter.abort(request)
  }

  observeOutput(
    event: RuntimePtyOwnershipTransferOutputObservation
  ): readonly PtyOwnershipTransferOutputFragment[] | undefined {
    const source = this.resolveSource(event.terminalId)
    if (!source || source.incarnationId !== event.incarnationId) {
      return undefined
    }
    const observedIncarnation = this.observedIncarnations.get(event.terminalId)
    if (observedIncarnation && observedIncarnation !== event.incarnationId) {
      return undefined
    }
    this.observedIncarnations.set(event.terminalId, event.incarnationId)
    return this.adapter.observeOutput(event.terminalId, event.data, event.emissionKey)
  }

  observeExit(event: { terminalId: string; incarnationId: string; code?: number }): void {
    this.adapter.observeExit(event)
    if (this.observedIncarnations.get(event.terminalId) === event.incarnationId) {
      this.adapter.removeTerminal(event.terminalId, event.incarnationId)
      this.observedIncarnations.delete(event.terminalId)
    }
  }

  removeTerminal(terminalId: string): void {
    this.adapter.removeTerminal(terminalId)
  }

  snapshot(bridgeId: string): RelayPtyOwnershipTransferSnapshot | null {
    return this.adapter.snapshot(bridgeId)
  }

  /** Provider replacement invalidates ephemeral observation, never durable transfer identity. */
  beginProviderReplacement(): void {
    this.observedIncarnations.clear()
  }

  restoreInputFences(): number {
    return this.adapter.restoreInputFences()
  }

  private assertMutationAuthorized(
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): void {
    if (!this.routesComplete || !this.authorizeMutationRequest || !this.mutationEnabled()) {
      throw new Error('pty_ownership_transfer_runtime_source_unavailable')
    }
    if (binding.isStale()) {
      throw new Error('pty_ownership_transfer_runtime_request_stale')
    }
    if (!this.authorizeMutationRequest(method, request, binding)) {
      throw new Error('pty_ownership_transfer_runtime_request_unauthorized')
    }
    if (binding.isStale()) {
      throw new Error('pty_ownership_transfer_runtime_request_stale')
    }
  }
}
