import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './db'
import {
  hasUnfilteredOrchestrationWaiter,
  messageTypeHasOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

export function getOrchestrationMailboxPointerCandidates<
  TWaiter extends OrchestrationMessageWaiter
>(
  db: OrchestrationDb,
  mailboxHandle: string,
  waiters: ReadonlySet<TWaiter> | undefined,
  reservedTypes?: ReadonlySet<string>
) {
  if (hasUnfilteredOrchestrationWaiter(waiters)) {
    return []
  }
  const excludedTypes = new Set(reservedTypes)
  for (const waiter of waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excludedTypes.add(type)
    }
  }
  return db
    .getUndeliveredUnreadMessages(mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    .filter(
      (message) =>
        !reservedTypes?.has(message.type) &&
        !messageTypeHasOrchestrationWaiter(waiters, message.type)
    )
    .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
}
