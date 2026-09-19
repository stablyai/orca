import type { PtySourceSpan } from '../../shared/pty-source-credit-contract'
import type { SshPtyOwnershipTransferSourceRange } from './ssh-pty-output-source-obligations'

/** Maximum number of destination receipts retained while source admission is delayed. */
export const MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS = 4096

/** Bounded handoff for destination receipts that precede source-span admission. */
export class SshPtyOwnershipTransferPendingSettlements {
  private readonly pending = new Map<string, SshPtyOwnershipTransferSourceRange>()

  get size(): number {
    return this.pending.size
  }

  retain(range: SshPtyOwnershipTransferSourceRange): void {
    const key = settlementKey(range)
    const existing = this.pending.get(key)
    if (existing) {
      if (!sameRange(existing, range)) {
        throw new Error('ssh_pty_ownership_transfer_pending_settlement_conflict')
      }
      return
    }
    if (this.pending.size >= MAX_PENDING_SSH_PTY_OWNERSHIP_TRANSFER_SETTLEMENTS) {
      throw new Error('ssh_pty_ownership_transfer_pending_settlement_capacity')
    }
    this.pending.set(key, range)
  }

  take(span: PtySourceSpan): SshPtyOwnershipTransferSourceRange | null {
    const transfer = span.ownershipTransfer
    if (!transfer) {
      return null
    }
    const key = settlementKey({
      providerGeneration: span.providerGeneration,
      relayPtyId: span.id,
      spanId: span.spanId,
      deliveryToken: span.deliveryToken,
      ownershipTransfer: transfer
    })
    const range = this.pending.get(key)
    if (!range) {
      return null
    }
    if (!sameRangeAsSpan(range, span)) {
      throw new Error('ssh_pty_ownership_transfer_pending_settlement_stale')
    }
    this.pending.delete(key)
    return range
  }

  closeGeneration(providerGeneration: number): void {
    for (const [key, range] of this.pending) {
      if (range.providerGeneration === providerGeneration) {
        this.pending.delete(key)
      }
    }
  }

  clear(): void {
    this.pending.clear()
  }
}

export function requireRangeMatchesSpan(
  range: SshPtyOwnershipTransferSourceRange,
  span: PtySourceSpan
): void {
  if (!sameRangeAsSpan(range, span)) {
    throw new Error('SSH PTY ownership-transfer settlement has a stale source range')
  }
}

function settlementKey(
  range: Pick<
    SshPtyOwnershipTransferSourceRange,
    'providerGeneration' | 'relayPtyId' | 'deliveryToken' | 'spanId' | 'ownershipTransfer'
  >
): string {
  return `${range.providerGeneration}\0${range.relayPtyId}\0${range.deliveryToken}\0${range.spanId}\0${range.ownershipTransfer.bridgeId}`
}

function sameRangeAsSpan(range: SshPtyOwnershipTransferSourceRange, span: PtySourceSpan): boolean {
  const transfer = span.ownershipTransfer
  return Boolean(
    transfer &&
    range.providerGeneration === span.providerGeneration &&
    range.relayPtyId === span.id &&
    range.spanId === span.spanId &&
    range.clientGeneration === span.clientGeneration &&
    range.ownerGeneration === span.ownerGeneration &&
    range.deliveryToken === span.deliveryToken &&
    range.ptyIncarnation === span.ptyIncarnation &&
    range.sourceStartSu === span.sourceStartSu &&
    range.sourceEndSu === span.sourceEndSu &&
    sameTransfer(range.ownershipTransfer, transfer)
  )
}

function sameRange(
  left: SshPtyOwnershipTransferSourceRange,
  right: SshPtyOwnershipTransferSourceRange
): boolean {
  return (
    left.providerGeneration === right.providerGeneration &&
    left.relayPtyId === right.relayPtyId &&
    left.spanId === right.spanId &&
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.deliveryToken === right.deliveryToken &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.sourceStartSu === right.sourceStartSu &&
    left.sourceEndSu === right.sourceEndSu &&
    sameTransfer(left.ownershipTransfer, right.ownershipTransfer)
  )
}

function sameTransfer(
  left: SshPtyOwnershipTransferSourceRange['ownershipTransfer'],
  right: NonNullable<PtySourceSpan['ownershipTransfer']>
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId &&
    left.version === right.version &&
    left.frameSeq === right.frameSeq &&
    left.fragmentStartSu === right.fragmentStartSu &&
    left.fragmentEndSu === right.fragmentEndSu &&
    left.frameLengthSu === right.frameLengthSu
  )
}
