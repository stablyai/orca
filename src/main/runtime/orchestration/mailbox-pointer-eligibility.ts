import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './db'
import type { MessageRow } from './types'

export type OrchestrationMessageWaiter = { typeFilter: string[] | undefined }


export function messageTypeHasOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  messageType: string
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter || waiter.typeFilter.includes(messageType)) {
      return true
    }
  }
  return false
}

export function hasUnfilteredOrchestrationWaiter(
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  for (const waiter of waiters ?? []) {
    if (!waiter.typeFilter) {
      return true
    }
  }
  return false
}

export function shouldReleaseOrchestrationPointer(
  db: OrchestrationDb | null,
  mailboxHandle: string,
  messages: readonly { id: string; type: string }[],
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  if (
    mailboxHandle.startsWith('run:') &&
    db?.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length))
  ) {
    return true
  }
  if (messages.some((message) => messageTypeHasOrchestrationWaiter(waiters, message.type))) {
    return true
  }
  return !(
    db?.areUnreadMessages?.(
      mailboxHandle,
      messages.map((message) => message.id)
    ) ?? true
  )
}

// Why: which rows a pointer may advertise is an eligibility question, so it belongs with the
// waiter predicates rather than inline in the delivery path. Excluded types are pushed into SQL
// where they narrow the read; the payload-dependent heartbeat rule can only be answered per row.
export function selectPointerDeliveryBatch(
  db: OrchestrationDb,
  mailboxHandle: string,
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined,
  reservedTypes: ReadonlySet<string> | undefined
): MessageRow[] {
  const excludedTypes = new Set(reservedTypes)
  for (const waiter of waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excludedTypes.add(type)
    }
  }
  return db
    .getUndeliveredUnreadMessages(mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      // Why: a heartbeat's whole content is "nothing changed", so pushing it spends a coordinator
      // turn to convey that — six lanes at the preamble's 5-minute cadence is roughly 72 wakes an
      // hour (#14910). It is excluded in the query rather than here because heartbeats are never
      // delivered and never leave the queue, so filtering after LIMIT would eventually starve the
      // push of everything else. The row stays unread, so an explicit check still audits it.
      excludeSilentHeartbeats: true,
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    .filter(
      (message) =>
        !reservedTypes?.has(message.type) &&
        !messageTypeHasOrchestrationWaiter(waiters, message.type)
    )
    .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
}
