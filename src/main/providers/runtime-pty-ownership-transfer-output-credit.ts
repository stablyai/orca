import type { RelayPtyOwnershipTransferAdapter } from '../../relay/relay-pty-ownership-transfer-adapter'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import type {
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferOutputAcknowledgementRequest,
  PtyOwnershipTransferOutputAcknowledgementResult
} from '../../shared/pty-ownership-transfer-wire'
import {
  requestContext,
  type RuntimePtyOwnershipTransferAttachmentBinding
} from './runtime-pty-ownership-transfer-attachment-binding'

export class RuntimePtyOwnershipTransferOutputCredit {
  private readonly outputAcknowledgements = new Map<
    string,
    {
      binding: RuntimePtyOwnershipTransferAttachmentBinding
      acknowledge: (throughSeq: number) => void
    }
  >()

  constructor(private readonly adapter: RelayPtyOwnershipTransferAdapter) {}

  /** Register the authenticated stream callback used by cumulative output ACKs. */
  register(
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    binding: RuntimePtyOwnershipTransferAttachmentBinding,
    acknowledge: (throughSeq: number) => void
  ): () => void {
    if (!attachmentId) {
      throw new Error('pty_ownership_transfer_attachment_id_invalid')
    }
    if (binding.isStale()) {
      throw new Error('pty_ownership_transfer_runtime_request_stale')
    }
    const transfer = this.adapter.snapshot(identity.bridgeId)
    if (
      !transfer ||
      transfer.phase === 'aborted' ||
      !samePtyOwnershipTransferIdentity(transfer.identity, identity)
    ) {
      throw new Error('pty_ownership_transfer_output_credit_attachment_unavailable')
    }
    const key = outputAcknowledgementKey(identity, attachmentId)
    const existing = this.outputAcknowledgements.get(key)
    if (existing) {
      const existingActive = this.adapter.isDestinationAttachmentActive(
        { ...identity, attachmentId },
        requestContext(existing.binding)
      )
      if (existing.binding.isStale() || !existingActive) {
        this.outputAcknowledgements.delete(key)
      } else {
        throw new Error('pty_ownership_transfer_output_credit_stream_exists')
      }
    }
    const registration = {
      binding,
      acknowledge
    }
    this.outputAcknowledgements.set(key, registration)
    return () => {
      if (this.outputAcknowledgements.get(key) === registration) {
        this.outputAcknowledgements.delete(key)
      }
    }
  }

  /** Deliver a cumulative output ACK only to the matching live authenticated stream. */
  acknowledge(
    request: PtyOwnershipTransferOutputAcknowledgementRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): PtyOwnershipTransferOutputAcknowledgementResult {
    const key = outputAcknowledgementKey(request, request.attachmentId)
    const registration = this.outputAcknowledgements.get(key)
    if (!registration) {
      throw new Error('pty_ownership_transfer_output_credit_ack_unregistered')
    }
    if (
      registration.binding.clientId !== binding.clientId ||
      registration.binding.transportGeneration !== binding.transportGeneration
    ) {
      throw new Error('pty_ownership_transfer_output_credit_ack_stale_binding')
    }
    if (!this.adapter.isDestinationAttachmentActive(request, requestContext(binding))) {
      throw new Error('pty_ownership_transfer_output_credit_attachment_unavailable')
    }
    registration.acknowledge(request.throughSeq)
    const {
      bridgeId,
      terminalId,
      incarnationId,
      ownerLease,
      sourceOwnerGeneration,
      destinationRuntimeId
    } = request
    return Object.freeze({
      version: 1,
      identity: Object.freeze({
        bridgeId,
        terminalId,
        incarnationId,
        ownerLease,
        sourceOwnerGeneration,
        destinationRuntimeId
      }),
      attachmentId: request.attachmentId,
      throughSeq: request.throughSeq
    })
  }
}

function outputAcknowledgementKey(
  identity: PtyOwnershipTransferWireIdentity,
  attachmentId: string
): string {
  return JSON.stringify({
    bridgeId: identity.bridgeId,
    terminalId: identity.terminalId,
    incarnationId: identity.incarnationId,
    ownerLease: identity.ownerLease,
    sourceOwnerGeneration: identity.sourceOwnerGeneration,
    destinationRuntimeId: identity.destinationRuntimeId,
    attachmentId
  })
}
