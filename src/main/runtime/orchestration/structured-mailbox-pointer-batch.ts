import type { MessageRow, OrchestrationDb } from './db'
import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

/** Each page moves past its last row, including failures; arrivals belong to the next pass. */
export async function visitStructuredMailboxPages(input: {
  db: OrchestrationDb
  mailboxHandle: string
  throughSequence: number
  reservedTypes: ReadonlySet<string> | undefined
  getWaiters: () => ReadonlySet<OrchestrationMessageWaiter> | undefined
  isCurrent: () => boolean
  attempt: (messages: readonly MessageRow[]) => Promise<boolean>
}): Promise<void> {
  let afterSequence: number | undefined
  while (input.isCurrent()) {
    const unread = selectOrchestrationPointerBatch({
      db: input.db,
      mailboxHandle: input.mailboxHandle,
      waiters: input.getWaiters(),
      reservedTypes: input.reservedTypes,
      afterSequence,
      throughSequence: input.throughSequence
    })
    const last = unread.at(-1)
    if (!last || !(await input.attempt(unread))) {
      return
    }
    afterSequence = last.sequence
    if (afterSequence >= input.throughSequence) {
      return
    }
    await yieldToEventLoop()
  }
}
