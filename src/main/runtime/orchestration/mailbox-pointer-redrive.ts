import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

export function redriveMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  state: OrchestrationMailboxPointerState,
  deps: PointerDeliveryDependencies<TWaiter>,
  mailboxHandle: string,
  force = false
): void {
  const parkedTypes = state.takeRedelivery(mailboxHandle, force)
  if (parkedTypes === undefined) {
    return
  }
  queueMicrotask(() => {
    try {
      const db = deps.getDb()
      if (db && db.getUndeliveredUnreadMessages(mailboxHandle).length === 0) {
        return
      }
      deps.redriveMailbox(mailboxHandle, parkedTypes ?? undefined)
    } catch {}
  })
}
