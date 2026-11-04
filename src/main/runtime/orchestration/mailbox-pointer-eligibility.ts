import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type MessageRow, type OrchestrationDb } from './db'

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
  /** Read strictly after this sequence. Set only to pass a full page of held mail. */
  afterSequence?: number
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
  return {
    messages: input.db.getUndeliveredUnreadMessages(
      input.mailboxHandle,
      undefined,
      {
        excludeTypes: [...excludedTypes],
        excludeIds: held?.messageIds,
        limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
      },
      input.afterSequence
    ),
    heldDeliveryId: held?.id
  }
}

/** Where to read next when this page was full and every admission was held. A short page, or any real
 *  delivery, stays put so one pass sends at most one batch. */
export function heldOrchestrationPageCursor(
  messages: readonly { sequence: number }[],
  everyAdmitHeld: boolean,
  afterSequence: number | undefined
): number | undefined {
  const last = messages.at(-1)?.sequence
  if (
    !everyAdmitHeld ||
    last === undefined ||
    messages.length < ORCHESTRATION_DELIVERY_BATCH_LIMIT ||
    last <= (afterSequence ?? -1)
  ) {
    return undefined
  }
  return last
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
