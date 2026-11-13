import '../../db/orchestration-db'
import '../../db/contract-constants'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { MessageRow } from '../../db/orchestration-records'
import type { OrchestrationDb } from '../../db/orchestration-db'
import { parseRunNotifyTypes } from '../../db/runs/run-notify-types'

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

export type OrchestrationPointerBatch = {
  messages: MessageRow[]
  /** The consumer's unacked batch, named in the reminder. */
  heldDeliveryId: string | undefined
}

/** Both delivery lanes share this synchronous SQL selection; unfiltered waiters preempt all pointers.
 * Concrete waiter types are excluded byte-exactly in SQL; no JavaScript post-filter is needed.
 * An unacked batch defers rather than drops: only mail it does not hold is eligible, once each. */
export function selectOrchestrationPointerBatch(input: {
  db: OrchestrationDb
  mailboxHandle: string
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
  reservedTypes: ReadonlySet<string> | undefined
  /** A terminal's own mailbox leaves rows a Run owns undelivered for routing to move. */
  excludeRunOwnedDirect?: boolean
}): OrchestrationPointerBatch {
  if (hasUnfilteredOrchestrationWaiter(input.waiters)) {
    return { messages: [], heldDeliveryId: undefined }
  }
  const excludedTypes = new Set(input.reservedTypes)
  for (const waiter of input.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excludedTypes.add(type)
    }
  }
  const held = input.db.getOutstandingMailboxDelivery?.(input.mailboxHandle)
  const exclusion = {
    excludeTypes: [...excludedTypes],
    excludeRunOwnedDirect: input.excludeRunOwnedDirect
  }
  // The Run's notify list gates the wake only: a waking batch still carries every other unread type.
  const runWakeTypes = input.mailboxHandle.startsWith('run:')
    ? parseRunNotifyTypes(input.db.getRun(input.mailboxHandle.slice('run:'.length))?.notify_types)
    : null
  if (!runWakeTypes) {
    return {
      messages: input.db.getUndeliveredUnreadMessages(input.mailboxHandle, undefined, {
        ...exclusion,
        excludeIds: held?.messageIds,
        limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
      }),
      heldDeliveryId: held?.id
    }
  }
  const wakeTypes = runWakeTypes.filter((type) => !excludedTypes.has(type))
  if (wakeTypes.length === 0) {
    return { messages: [], heldDeliveryId: undefined }
  }
  // Wake rows first: a long non-waking backlog must not fill the batch and hide the type that woke us.
  const waking = input.db.getUndeliveredUnreadMessages(input.mailboxHandle, wakeTypes, {
    ...exclusion,
    excludeIds: held?.messageIds,
    limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
  })
  if (waking.length === 0) {
    return { messages: [], heldDeliveryId: undefined }
  }
  const remainderLimit = ORCHESTRATION_DELIVERY_BATCH_LIMIT - waking.length
  const remainder =
    remainderLimit > 0
      ? input.db.getUndeliveredUnreadMessages(input.mailboxHandle, undefined, {
          ...exclusion,
          excludeIds: [...(held?.messageIds ?? []), ...waking.map((message) => message.id)],
          limit: remainderLimit
        })
      : []
  return {
    messages: [...waking, ...remainder].sort((a, b) => a.sequence - b.sequence),
    heldDeliveryId: held?.id
  }
}

export function shouldReleaseOrchestrationPointer(
  db: OrchestrationDb | null,
  mailboxHandle: string,
  messages: readonly { id: string; type: string }[],
  waiters: ReadonlySet<OrchestrationMessageWaiter> | undefined
): boolean {
  // A check that took this pointer's mail into a batch already showed it to the agent.
  const held = db?.getOutstandingMailboxDelivery?.(mailboxHandle)
  if (held && messages.some((message) => held.messageIds.includes(message.id))) {
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
