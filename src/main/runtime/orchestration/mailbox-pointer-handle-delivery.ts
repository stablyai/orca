import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import { getOrchestrationMailboxPointerCandidates } from './mailbox-pointer-candidates'
import type { OrchestrationMailboxStatuslessCodexProofCoordinator } from './mailbox-statusless-codex-proof-coordinator'
import type { OrchestrationStatuslessIdleProof } from './mailbox-pointer-state'

export type OrchestrationMailboxPointerDeliveryOptions = {
  mailboxHandle: string
  reservedTypes?: ReadonlySet<string>
  skipAbsenceProbe?: boolean
  statuslessIdleProof?: OrchestrationStatuslessIdleProof
}

type DeliverPointer = (
  leaf: OrchestrationMailboxLeaf,
  options: OrchestrationMailboxPointerDeliveryOptions
) => void

export class OrchestrationMailboxPointerHandleDelivery<TWaiter extends OrchestrationMessageWaiter> {
  constructor(
    private readonly deps: PointerDeliveryDependencies<TWaiter>,
    private readonly statuslessCodexProofs: OrchestrationMailboxStatuslessCodexProofCoordinator,
    private readonly deliver: DeliverPointer
  ) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    const terminalHandle = this.deps.deliveryTarget.resolveTerminalHandle(handle)
    if (!terminalHandle) {
      // The message itself proves the slept recipient is owed work.
      this.deps.requestSleepingRecipientWake?.(handle)
      return
    }
    try {
      const leaf = this.deps.getLiveLeafForHandle(terminalHandle)
      // A listable pane without a PTY cannot emit the idle edge needed for delivery.
      if (!leaf.ptyId) {
        this.deps.requestSleepingRecipientWake?.(handle)
        return
      }
      if (leaf.lastAgentStatus === 'idle' && leaf.lastAgentStatusObservedLive) {
        const mailboxHandle = this.deps.mailboxOwner.resolve(leaf, handle)
        if (mailboxHandle) {
          this.deliver(leaf, { mailboxHandle, reservedTypes })
        }
        return
      }
      if (leaf.lastAgentStatus !== null) {
        return
      }
      const mailboxHandle = this.deps.mailboxOwner.resolve(leaf, handle)
      const db = this.deps.getDb()
      if (
        !db ||
        !mailboxHandle?.startsWith('run:') ||
        db.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length)) ||
        (getOrchestrationMailboxPointerCandidates(
          db,
          mailboxHandle,
          this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes
        ).length === 0 &&
          // A pending pointer reservation still needs the resume pass in deliver().
          db.getPendingMailboxPointerMessages(mailboxHandle).length === 0)
      ) {
        return
      }
      this.statuslessCodexProofs.runWhenProven(
        terminalHandle,
        leaf,
        (currentLeaf, statuslessIdleProof) => {
          const currentMailbox = this.deps.mailboxOwner.resolve(currentLeaf, handle)
          if (currentMailbox === mailboxHandle) {
            this.deliver(currentLeaf, {
              mailboxHandle,
              reservedTypes,
              statuslessIdleProof
            })
          }
        }
      )
    } catch {
      // Persisted mail remains available to explicit check or a later idle edge.
      this.deps.requestSleepingRecipientWake?.(handle)
    }
  }
}
