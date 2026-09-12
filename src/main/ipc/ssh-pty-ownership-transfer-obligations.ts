import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'
import type {
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'
import type { SshPtySourceObligationCoordinator } from './ssh-pty-source-obligation-coordinator'
import {
  requireRangeMatchesSpan,
  SshPtyOwnershipTransferPendingSettlements
} from './ssh-pty-ownership-transfer-pending-settlements'
import { SshPtyClosedGenerationRanges } from './ssh-pty-closed-generation-ranges'

export type SshPtyOwnershipTransferSourceRange = Readonly<{
  providerGeneration: number
  relayPtyId: string
  spanId: string
  clientGeneration: number
  ownerGeneration: number
  deliveryToken: string
  ptyIncarnation: string
  sourceStartSu: number
  sourceEndSu: number
  ownershipTransfer: PtyOwnershipTransferOutputEnvelope
}>

/** Owns destination receipts that race source-span admission. */
export class SshPtyOwnershipTransferObligations {
  private readonly pending = new SshPtyOwnershipTransferPendingSettlements()
  private readonly closedGenerations = new SshPtyClosedGenerationRanges()

  constructor(
    private readonly coordinator: SshPtySourceObligationCoordinator,
    private readonly enabled: boolean
  ) {}

  isEnabled(): boolean {
    return this.enabled
  }

  afterCommit(span: PtySourceSpan): void {
    if (!this.enabled) {
      return
    }
    const pending = this.pending.take(span)
    if (!pending) {
      return
    }
    try {
      this.settleRetained(span, pending)
    } catch (error) {
      this.pending.retain(pending)
      throw error
    }
  }

  settle(range: SshPtyOwnershipTransferSourceRange): void {
    if (!this.enabled || this.closedGenerations.has(range.providerGeneration)) {
      return
    }
    if (!this.coordinator.hasRetainedSpan(range.spanId)) {
      this.pending.retain(range)
      return
    }
    const span = this.coordinator.spanIdentity(range.spanId)
    requireRangeMatchesSpan(range, span)
    this.settleRetained(span, range)
  }

  closeGeneration(providerGeneration: number): void {
    this.closedGenerations.add(providerGeneration)
    this.pending.closeGeneration(providerGeneration)
  }

  dispose(): void {
    this.pending.clear()
  }

  pendingCount(): number {
    return this.pending.size
  }

  private settleRetained(span: PtySourceSpan, range: SshPtyOwnershipTransferSourceRange): void {
    const identity: PtySourceDeliveryIdentity = {
      id: range.relayPtyId,
      providerGeneration: range.providerGeneration,
      clientGeneration: range.clientGeneration,
      ownerGeneration: range.ownerGeneration,
      ptyIncarnation: range.ptyIncarnation,
      deliveryToken: range.deliveryToken
    }
    this.coordinator.settle({
      identity,
      spanId: span.spanId,
      consumer: `ownership-transfer:${range.ownershipTransfer.bridgeId}`,
      reason: 'destination-output-durable'
    })
  }
}
