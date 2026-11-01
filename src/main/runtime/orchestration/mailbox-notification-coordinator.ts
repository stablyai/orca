import type { OrchestrationDb } from './db'
import type {
  OrchestrationMailboxOwner,
  OrchestrationMailboxTerminal,
  RoutedOrchestrationMailbox
} from './mailbox-owner'
import type {
  OrchestrationMailboxPointerDelivery,
  OrchestrationMessageWaiter
} from './mailbox-pointer-delivery'
import {
  hasUnfilteredOrchestrationWaiter,
  selectOrchestrationPointerBatch
} from './mailbox-pointer-eligibility'
import type { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'

type NotificationCoordinatorDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  pointerDelivery: OrchestrationMailboxPointerDelivery<TWaiter>
  /** Sibling lane for workers that ARE a structured session; it has no PTY to type into. */
  structuredPointerDelivery?: OrchestrationStructuredMailboxPointerDelivery<TWaiter>
  getDb: () => OrchestrationDb | null
  getTerminalForHandle: (handle: string) => OrchestrationMailboxTerminal | null
  getPaneKeyForHandle: (handle: string) => string | undefined
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  hasTerminalHandle: (handle: string) => boolean
  deliverForHandle: (handle: string, reservedTypes?: ReadonlySet<string>) => void
  notifyMessageArrived: (handle: string, messageType: string) => void
  /** Waiters resolved together share one wake, so they share the batch the first one takes. */
  resolveMessageWaiters: (waiters: readonly TWaiter[]) => void
}

export class OrchestrationMailboxNotificationCoordinator<
  TWaiter extends OrchestrationMessageWaiter
> {
  constructor(private readonly deps: NotificationCoordinatorDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    if (this.deps.structuredPointerDelivery?.deliverForHandle(handle, reservedTypes)) {
      return
    }
    this.deps.pointerDelivery.deliverForHandle(handle, reservedTypes)
  }

  deliverForTerminal(terminal: OrchestrationMailboxTerminal): void {
    this.notifyForwarded(this.deps.mailboxOwner.routeForeignDirectMessages(terminal))
    for (const mailboxHandle of this.deps.mailboxOwner.resolveAll(terminal)) {
      this.deps.pointerDelivery.deliver(terminal, { mailboxHandle })
    }
  }

  /** Whether delivery has work for this terminal: a pointer reservation to recover, or unread, undelivered mail no waiter or held batch claims. */
  hasDeliverableMail(terminal: OrchestrationMailboxTerminal): boolean {
    const db = this.deps.getDb()
    return (
      !!db &&
      this.deps.mailboxOwner.resolveAll(terminal).some((mailboxHandle) => {
        const waiters = this.deps.getMessageWaiters(mailboxHandle)
        return (
          // Mirrors deliver(): an unfiltered waiter preempts recovery too.
          !hasUnfilteredOrchestrationWaiter(waiters) &&
          (db.getPendingMailboxPointerMessages(mailboxHandle).length > 0 ||
            selectOrchestrationPointerBatch({
              db,
              mailboxHandle,
              waiters,
              reservedTypes: undefined
            }).messages.length > 0)
        )
      })
    )
  }

  notifyMessageArrived(handle: string, messageType?: string): void {
    const { mailboxHandle, forwarded, directTypes } = this.resolveArrivedMailboxes(handle)
    this.notifyForwarded(forwarded)
    if (!mailboxHandle) {
      return
    }
    const waiters = this.deps.getMessageWaiters(mailboxHandle)
    const arrivedTypes = directTypes ?? (messageType ? [messageType] : undefined)
    const consumers = waiters
      ? [...waiters].filter(
          (waiter) =>
            !arrivedTypes ||
            !waiter.typeFilter ||
            arrivedTypes.some((type) => waiter.typeFilter?.includes(type))
        )
      : []
    if (consumers.length === 0) {
      const reservedTypes = new Set(
        waiters ? [...waiters].flatMap((waiter) => waiter.typeFilter ?? []) : []
      )
      // Let a check awakened in this drain mark its rows read before the push re-reads them.
      queueMicrotask(() => this.deps.deliverForHandle(mailboxHandle, reservedTypes))
      return
    }
    this.deps.resolveMessageWaiters(consumers)
  }

  wakeRoutedMessageWaiters(mailboxHandle: string, types: readonly string[]): void {
    const waiters = [...(this.deps.getMessageWaiters(mailboxHandle) ?? [])]
    if (waiters.length === 0 || types.length === 0) {
      return
    }
    // Snapshot ownership before the routed rows wake and remove their waiters.
    queueMicrotask(() => {
      const liveWaiters = this.deps.getMessageWaiters(mailboxHandle)
      this.deps.resolveMessageWaiters(
        waiters.filter(
          (waiter) =>
            liveWaiters?.has(waiter) &&
            (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        )
      )
    })
  }

  retirePty(ptyId: string): void {
    this.deps.pointerDelivery.retirePty(ptyId)
  }

  private resolveArrivedMailboxes(handle: string): {
    mailboxHandle: string | null
    forwarded: RoutedOrchestrationMailbox[]
    directTypes?: string[]
  } {
    if (handle.startsWith('run:') || handle.startsWith('dispatch:')) {
      return { mailboxHandle: handle, forwarded: [] }
    }
    if (!this.deps.getDb()) {
      return { mailboxHandle: handle, forwarded: [] }
    }
    if (!this.deps.hasTerminalHandle(handle)) {
      return this.resolveDetachedMailbox(handle)
    }
    const terminal = this.deps.getTerminalForHandle(handle)
    if (!terminal) {
      return this.resolveDetachedMailbox(handle)
    }
    return {
      mailboxHandle: this.deps.mailboxOwner.resolve(terminal, handle, {
        requireRequestedMail: true
      }),
      forwarded: this.deps.mailboxOwner.routeForeignDirectMessages(terminal)
    }
  }

  private resolveDetachedMailbox(handle: string): {
    mailboxHandle: string | null
    forwarded: RoutedOrchestrationMailbox[]
    directTypes?: string[]
  } {
    const routed = this.deps.mailboxOwner.routeDetachedDirectMessages(
      handle,
      this.deps.getPaneKeyForHandle(handle)
    )
    const directTypes = routed.hasMore
      ? []
      : (this.deps.getDb()?.getUnreadDirectMessageTypes(handle) ?? [])
    return {
      mailboxHandle: directTypes.length > 0 ? handle : null,
      forwarded: routed.mailboxes,
      directTypes
    }
  }

  private notifyForwarded(forwarded: readonly RoutedOrchestrationMailbox[]): void {
    for (const routed of forwarded) {
      for (const messageType of routed.types) {
        this.deps.notifyMessageArrived(routed.mailboxHandle, messageType)
      }
    }
  }
}
