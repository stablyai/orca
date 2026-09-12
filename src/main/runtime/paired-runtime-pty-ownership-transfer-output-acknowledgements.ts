import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type {
  PtyOwnershipTransferOutputAcknowledgementResult,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'

export type PairedRuntimePtyOwnershipTransferSendRequest = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

/** Coalesces durable destination delivery into one cumulative ACK at a time. */
export class PairedRuntimePtyOwnershipTransferOutputAcknowledgements {
  private pendingThrough = 0
  private acknowledgedThrough = 0
  private pump: Promise<void> | null = null
  private closed = false

  constructor(
    private readonly identity: PtyOwnershipTransferWireIdentity,
    private readonly attachmentId: string,
    private readonly sendRequest: PairedRuntimePtyOwnershipTransferSendRequest,
    private readonly onError: (error: unknown) => void
  ) {}

  schedule(throughSeq: number): void {
    if (this.closed || throughSeq <= this.acknowledgedThrough) {
      return
    }
    this.pendingThrough = Math.max(this.pendingThrough, throughSeq)
    if (this.pump) {
      return
    }
    const pump = this.pumpAcknowledgements()
    this.pump = pump
    void pump.catch(this.onError).finally(() => {
      if (this.pump !== pump) {
        return
      }
      this.pump = null
      if (!this.closed && this.pendingThrough > this.acknowledgedThrough) {
        this.schedule(this.pendingThrough)
      }
    })
  }

  close(): void {
    this.closed = true
  }

  private async pumpAcknowledgements(): Promise<void> {
    while (!this.closed && this.pendingThrough > this.acknowledgedThrough) {
      const throughSeq = this.pendingThrough
      await this.acknowledge(throughSeq)
      this.acknowledgedThrough = throughSeq
    }
  }

  private async acknowledge(throughSeq: number): Promise<void> {
    const response = await this.sendRequest(
      'pty.ownershipTransfer.acknowledgeOutput',
      {
        ...this.identity,
        version: 1,
        attachmentId: this.attachmentId,
        throughSeq
      },
      10_000
    )
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    this.assertAcknowledgement(response.result, throughSeq)
  }

  private assertAcknowledgement(value: unknown, throughSeq: number): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('pty_ownership_transfer_output_credit_ack_invalid')
    }
    const result = value as Partial<PtyOwnershipTransferOutputAcknowledgementResult>
    const identity = parsePtyOwnershipTransferWireIdentity(result.identity)
    if (
      result.version !== 1 ||
      result.attachmentId !== this.attachmentId ||
      result.throughSeq !== throughSeq ||
      !samePtyOwnershipTransferIdentity(identity, this.identity)
    ) {
      throw new Error('pty_ownership_transfer_output_credit_ack_invalid')
    }
  }
}
