import type { PtySourceDeliveryCancellation } from '../shared/pty-source-credit-contract'
import type { PtyConsumerSessionGrant } from '../shared/pty-consumer-session'

export const RECENT_PTY_SOURCE_CANCELLATION_LIMIT = 256

export class RecentPtySourceCancellationIndex {
  private readonly proofs = new Map<string, PtySourceDeliveryCancellation>()

  remember(proof: PtySourceDeliveryCancellation): void {
    this.proofs.set(proof.deliveryToken, proof)
    while (this.proofs.size > RECENT_PTY_SOURCE_CANCELLATION_LIMIT) {
      this.proofs.delete(this.proofs.keys().next().value!)
    }
  }

  get(deliveryToken: string): PtySourceDeliveryCancellation | undefined {
    return this.proofs.get(deliveryToken)
  }

  owned(
    deliveryToken: string,
    params: Record<string, unknown>,
    grant: Readonly<PtyConsumerSessionGrant> | null
  ): PtySourceDeliveryCancellation | undefined {
    const proof = this.proofs.get(deliveryToken)
    return grant?.capabilities?.outputFlowControl &&
      proof?.clientGeneration === grant.clientGeneration &&
      params.id === proof.id &&
      Number(params.clientGeneration) === proof.clientGeneration &&
      Number(params.ownerGeneration) === proof.ownerGeneration
      ? proof
      : undefined
  }

  clear(): void {
    this.proofs.clear()
  }
}

export function ptySourceCancellationResult(
  proof: Readonly<{ sentEndSu: number; creditedEndSu: number }>
) {
  return Object.freeze({
    canceled: true as const,
    sentEndSu: proof.sentEndSu,
    creditedEndSu: proof.creditedEndSu
  })
}
