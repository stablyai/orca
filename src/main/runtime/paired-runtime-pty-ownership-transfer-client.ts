import {
  PtyOwnershipTransferRequestClient,
  type PtyOwnershipTransferRequestOptions
} from '../providers/ssh-pty-ownership-transfer-client'
import type { CallPairedRuntimePtyOwnershipTransferRpc } from './paired-runtime-pty-ownership-transfer-rpc'
import type { SubscribePairedRuntimePtyOwnershipTransfer } from './paired-runtime-pty-ownership-transfer-rpc'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferExitEvent } from '../../shared/pty-ownership-transfer-control-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import {
  PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_BYTES,
  PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_FRAMES
} from '../../shared/pty-ownership-transfer-output-credit'
import { PairedRuntimePtyOwnershipTransferOutputAcknowledgements } from './paired-runtime-pty-ownership-transfer-output-acknowledgements'
import {
  acceptPtyOwnershipTransferOutputSequence,
  parsePtyOwnershipTransferSourceStreamEvent
} from './paired-runtime-pty-ownership-transfer-stream-event'
import {
  pairedRuntimePtyOwnershipTransferSourceStreamKey,
  type PairedRuntimePtyOwnershipTransferSourceStreamState
} from './paired-runtime-pty-ownership-transfer-stream-state'

type SourceStreamState = PairedRuntimePtyOwnershipTransferSourceStreamState

/** Strict unary source client; authoritative exit streaming remains a separate paired-runtime gate. */
export class PairedRuntimePtyOwnershipTransferClient extends PtyOwnershipTransferRequestClient {
  private readonly environmentId: string
  private readonly streams = new Map<string, SourceStreamState>()

  constructor(
    environmentId: string,
    callPairedRuntimeRpc: CallPairedRuntimePtyOwnershipTransferRpc,
    private readonly subscribePairedRuntime?: SubscribePairedRuntimePtyOwnershipTransfer
  ) {
    super((method, params, options?: PtyOwnershipTransferRequestOptions) =>
      callPairedRuntimeRpc(environmentId, method, params, options)
    )
    this.environmentId = environmentId
  }

  onDestinationOutput(
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: {
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }) => void | Promise<void>
  ): () => void {
    assertStreamingCapability(capabilities)
    const state = this.ensureSourceStream(identity, attachmentId)
    state.outputListeners.add(callback)
    return () => {
      state.outputListeners.delete(callback)
      this.releaseSourceStream(state)
    }
  }

  onDestinationExitForAttachment(
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ): () => void {
    assertStreamingCapability(capabilities)
    const state = this.ensureSourceStream(identity, attachmentId)
    state.exitListeners.add(callback)
    return () => {
      state.exitListeners.delete(callback)
      this.releaseSourceStream(state)
    }
  }

  waitForDestinationStreamReady(
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string
  ): Promise<void> {
    assertStreamingCapability(capabilities)
    return this.ensureSourceStream(identity, attachmentId).ready
  }

  onDestinationTransportLost(
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: () => void
  ): () => void {
    assertStreamingCapability(capabilities)
    const state = this.ensureSourceStream(identity, attachmentId)
    if (state.closed) {
      callback()
      return () => {}
    }
    state.transportLostListeners.add(callback)
    return () => {
      state.transportLostListeners.delete(callback)
      this.releaseSourceStream(state)
    }
  }

  private ensureSourceStream(
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string
  ): SourceStreamState {
    const key = pairedRuntimePtyOwnershipTransferSourceStreamKey(identity, attachmentId)
    const existing = this.streams.get(key)
    if (existing) {
      return existing
    }
    const subscribe = this.subscribePairedRuntime
    if (!subscribe) {
      throw new Error('pty_ownership_transfer_paired_stream_unsupported')
    }
    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const state: SourceStreamState = {
      key,
      identity: Object.freeze({ ...identity }),
      attachmentId,
      outputListeners: new Set(),
      exitListeners: new Set(),
      transportLostListeners: new Set(),
      closed: false,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      }),
      resolveReady,
      rejectReady,
      subscription: null,
      outputDeliveryTail: Promise.resolve(),
      acknowledgements: null
    }
    this.streams.set(key, state)
    state.subscription = subscribe(
      this.environmentId,
      'pty.ownershipTransfer.streamSource',
      {
        ...identity,
        version: 1,
        attachmentId,
        outputCredit: {
          version: 1,
          windowBytes: PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_BYTES,
          windowFrames: PTY_OWNERSHIP_TRANSFER_OUTPUT_CREDIT_DEFAULT_WINDOW_FRAMES
        }
      },
      {
        onEvent: (value) => {
          if (state.closed) {
            return
          }
          try {
            const event = parsePtyOwnershipTransferSourceStreamEvent(value)
            if (event.kind === 'ready') {
              if (
                event.attachmentId !== attachmentId ||
                !samePtyOwnershipTransferIdentity(event.identity, identity)
              ) {
                throw new Error('pty_ownership_transfer_stream_ready_identity_invalid')
              }
              if (!event.outputCredit) {
                throw new Error('pty_ownership_transfer_output_credit_unsupported')
              }
              state.outputCreditNegotiated = true
              void this.resolveReadyAfterWritableSubscription(state).catch((error) =>
                this.closeSourceStream(state, error)
              )
              return
            }
            if (event.kind === 'loss') {
              this.closeSourceStream(
                state,
                new Error(`pty_ownership_transfer_stream_loss:${event.code}`)
              )
              return
            }
            if (
              event.kind === 'output' &&
              (event.attachmentId !== attachmentId ||
                !samePtyOwnershipTransferIdentity(event.identity, identity))
            ) {
              return
            }
            if (
              event.kind === 'exit' &&
              (!samePtyOwnershipTransferIdentity(event.event, identity) ||
                event.event.attachmentId !== attachmentId)
            ) {
              return
            }
            if (event.kind === 'output') {
              if (!state.outputCreditNegotiated) {
                throw new Error('pty_ownership_transfer_output_credit_unsupported')
              }
              const sequence = acceptPtyOwnershipTransferOutputSequence(
                state.outputCursor,
                event.frame
              )
              state.outputCursor = sequence.cursor
              if (!sequence.accepted) {
                return
              }
              state.outputDeliveryTail = state.outputDeliveryTail
                .then(async () => {
                  await state.ready
                  if (state.closed) {
                    return
                  }
                  for (const listener of state.outputListeners) {
                    await listener(event)
                  }
                  const acknowledgements = state.acknowledgements
                  if (!acknowledgements) {
                    throw new Error('pty_ownership_transfer_output_credit_ack_unavailable')
                  }
                  acknowledgements.schedule(event.frame.seq)
                })
                .catch((error) => this.closeSourceStream(state, error))
            } else {
              for (const listener of state.exitListeners) {
                listener(event.event)
              }
            }
          } catch (error) {
            // A malformed frame after readiness invalidates liveness; never silently continue.
            this.closeSourceStream(state, error)
          }
        },
        onError: (error) => this.closeSourceStream(state, error),
        onClose: () =>
          this.closeSourceStream(state, new Error('pty_ownership_transfer_stream_closed'))
      }
    )
    // Promise rejection is surfaced through `ready`; keep the background subscription from
    // creating an unhandled rejection when callers only register a watcher.
    void state.subscription.catch((error) => {
      this.closeSourceStream(state, error)
    })
    return state
  }

  private async resolveReadyAfterWritableSubscription(state: SourceStreamState): Promise<void> {
    const subscription = await state.subscription
    if (state.closed) {
      return
    }
    if (!subscription?.sendRequest) {
      throw new Error('pty_ownership_transfer_output_credit_ack_unavailable')
    }
    state.acknowledgements ??= new PairedRuntimePtyOwnershipTransferOutputAcknowledgements(
      state.identity,
      state.attachmentId,
      subscription.sendRequest,
      (error) => this.closeSourceStream(state, error)
    )
    if (!state.readySettled) {
      state.readySettled = true
      state.resolveReady()
    }
  }

  private releaseSourceStream(state: SourceStreamState): void {
    if (
      state.outputListeners.size ||
      state.exitListeners.size ||
      state.transportLostListeners.size
    ) {
      return
    }
    this.closeSourceStream(state, new Error('pty_ownership_transfer_stream_released'), false)
  }

  private closeSourceStream(state: SourceStreamState, error: unknown, notify = true): void {
    if (state.closed) {
      return
    }
    state.closed = true
    state.acknowledgements?.close()
    if (!state.readySettled) {
      state.readySettled = true
      state.rejectReady(error)
    }
    if (notify) {
      for (const listener of state.transportLostListeners) {
        try {
          listener()
        } catch {
          // A destination loss observer must not prevent stream cleanup.
        }
      }
    }
    this.streams.delete(state.key)
    void state.subscription?.then((subscription) => subscription.close()).catch(() => undefined)
  }
}

function assertStreamingCapability(capabilities: PtyOwnershipBridgeCapabilities): void {
  if (
    !capabilities.liveTransfer ||
    !capabilities.destinationOutput ||
    !capabilities.authoritativeExit
  ) {
    throw new Error('pty_ownership_transfer_destination_stream_unsupported')
  }
}
