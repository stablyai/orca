import type { OrchestrationDb } from './db'
import { isOrchestrationMailboxAddress, RUN_MAILBOX_PREFIX } from './mailbox-address'

/** A pointable mailbox is a Run/Dispatch address whose prior delivery is settled. */
export function canPointAtMailbox(db: OrchestrationDb, mailboxHandle: string): boolean {
  if (!isOrchestrationMailboxAddress(mailboxHandle)) {
    return false
  }
  return !(
    mailboxHandle.startsWith(RUN_MAILBOX_PREFIX) &&
    db.hasOutstandingRunDelivery?.(mailboxHandle.slice(RUN_MAILBOX_PREFIX.length))
  )
}

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
