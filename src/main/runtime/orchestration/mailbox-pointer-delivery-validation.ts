import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import { shouldReleaseOrchestrationPointer } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
export function markMailboxDeliveryDelivered(
  db: { markAsDelivered: (messageIds: string[]) => void },
  messageIds: readonly string[],
  usedLegacyDeliveredTransition: boolean
): void {
  if (messageIds.length > 0 && !usedLegacyDeliveredTransition) {
    db.markAsDelivered([...messageIds])
  }
}

export function assertMailboxPointerDeliveryCurrent<
  TWaiter extends { typeFilter: string[] | undefined }
>(
  deps: PointerDeliveryDependencies<TWaiter>,
  state: OrchestrationMailboxPointerState,
  leaf: OrchestrationMailboxLeaf,
  mailboxHandle: string,
  unread: readonly { id: string; type: string; sequence: number }[],
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight
): void {
  const currentLeaf = deps.getLeaf(deps.getLeafKey(leaf.tabId, leaf.leafId))
  const ownerChanged =
    !state.isCurrentFlight(ptyId, flight) ||
    currentLeaf?.ptyId !== ptyId ||
    !currentLeaf.writable ||
    deps.mailboxOwner.resolve(currentLeaf) !== mailboxHandle
  const agentNoLongerIdle =
    currentLeaf?.lastAgentStatus !== 'idle' || !currentLeaf.lastAgentStatusObservedLive
  const messagesReleased = shouldReleaseOrchestrationPointer(
    deps.getDb(),
    mailboxHandle,
    unread,
    deps.getMessageWaiters(mailboxHandle)
  )
  if (!ownerChanged && !agentNoLongerIdle && !messagesReleased) {
    return
  }
  if (!flight.mutated && ownerChanged) {
    flight.redriveMailbox = mailboxHandle
  }
  throw new Error('orchestration_pointer_released')
}
