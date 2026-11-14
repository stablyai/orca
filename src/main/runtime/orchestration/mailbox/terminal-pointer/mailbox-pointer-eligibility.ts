import type {
  PointerDeliveryDependencies,
  PointerDeliveryOptions
} from './mailbox-pointer-delivery-contract'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import type { OrchestrationMailboxTerminal } from '../routing/mailbox-owner'
import '../../db/orchestration-db'
import '../../db/contract-constants'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { MessageRow } from '../../db/orchestration-records'
import type { OrchestrationDb } from '../../db/orchestration-db'

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
  return {
    messages: input.db.getUndeliveredUnreadMessages(input.mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      excludeIds: held?.messageIds,
      excludeRunOwnedDirect: input.excludeRunOwnedDirect,
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    }),
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

export function hasPendingMailboxPointerFlight<T extends OrchestrationMessageWaiter>(
  deps: PointerDeliveryDependencies<T>,
  terminal: OrchestrationMailboxTerminal,
  flight: OrchestrationMailboxDeliveryFlight | undefined
): boolean {
  const db = deps.getDb()
  if (
    !db ||
    !flight ||
    flight.processIncarnation !== deps.resolveSubmitTarget(terminal.ptyId)?.processIncarnation
  ) {
    return false
  }
  return flight.stagedMessageIds.some((id) => {
    const row = db.getMessageById(id)
    return (
      !!row &&
      row.read === 0 &&
      (row.pointer_enter_pending ?? 0) > 0 &&
      row.delivery_contract === 'current_delivery' &&
      row.pointer_pty_id === terminal.ptyId &&
      row.pointer_process_incarnation === flight.processIncarnation &&
      !hasUnfilteredOrchestrationWaiter(deps.getMessageWaiters(row.to_handle)) &&
      deps.mailboxOwner.resolve(terminal, row.to_handle, { routeDirectMail: false }) ===
        row.to_handle
    )
  })
}

export function resumeDeferredMailboxPointer<T extends OrchestrationMessageWaiter>(
  deps: PointerDeliveryDependencies<T>,
  state: OrchestrationMailboxPointerState,
  terminal: OrchestrationMailboxTerminal,
  coldParked: boolean,
  options?: PointerDeliveryOptions
): boolean {
  const ptyId = terminal.ptyId
  if (!state.hasFlight(ptyId)) {
    return false
  }
  const db = options && state.hasRecoveryFlight(ptyId) ? deps.getDb() : null
  if (db && options) {
    const newer = selectOrchestrationPointerBatch({
      db,
      mailboxHandle: options.mailboxHandle,
      waiters: deps.getMessageWaiters(options.mailboxHandle),
      reservedTypes: options.reservedTypes,
      excludeRunOwnedDirect: options.mailboxHandle === terminal.handle
    }).messages.at(-1)
    if (newer) {
      state.noteMailSequence(ptyId, newer.sequence)
    }
  }
  if (
    !state.hasActiveFlight(ptyId) &&
    (state.hasRecoveryFlight(ptyId) ||
      ((!coldParked || terminal.lastAgentStatus === 'idle') &&
        deps.isAgentSettledForDelivery(
          ptyId,
          undefined,
          undefined,
          state.flightForPty(ptyId)?.agent
        )))
  ) {
    state.takeDeferredEnter(ptyId)?.()
  }
  return true
}
