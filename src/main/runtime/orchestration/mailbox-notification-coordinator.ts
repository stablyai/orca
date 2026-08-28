import type { OrchestrationDb } from './db'
import type {
  OrchestrationMailboxLeaf,
  OrchestrationMailboxOwner,
  RoutedOrchestrationMailbox
} from './mailbox-owner'
import type {
  OrchestrationMailboxPointerDelivery,
  OrchestrationMessageWaiter
} from './mailbox-pointer-delivery'

type NotificationCoordinatorDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  pointerDelivery: OrchestrationMailboxPointerDelivery<TWaiter>
  getDb: () => OrchestrationDb | null
  getLiveLeafForHandle: (handle: string) => OrchestrationMailboxLeaf
  getPaneKeyForHandle: (handle: string) => string | undefined
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  hasTerminalHandle: (handle: string) => boolean
  deliverForHandle: (handle: string, reservedTypes?: ReadonlySet<string>) => void
  notifyMessageArrived: (handle: string, messageType: string) => void
  resolveMessageWaiter: (waiter: TWaiter) => void
}

export class OrchestrationMailboxNotificationCoordinator<
  TWaiter extends OrchestrationMessageWaiter
> {
  constructor(private readonly deps: NotificationCoordinatorDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.deps.pointerDelivery.deliverForHandle(handle, reservedTypes)
  }

  deliverForLeaf(leaf: OrchestrationMailboxLeaf): void {
    this.notifyForwarded(this.deps.mailboxOwner.routeForeignDirectMessages(leaf))
    const mailboxHandle = this.deps.mailboxOwner.resolve(leaf)
    if (mailboxHandle) {
      this.deps.pointerDelivery.deliver(leaf, { mailboxHandle })
    }
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
    for (const waiter of consumers) {
      this.deps.resolveMessageWaiter(waiter)
    }
  }

  wakeRoutedMessageWaiters(mailboxHandle: string, types: readonly string[]): void {
    const waiters = [...(this.deps.getMessageWaiters(mailboxHandle) ?? [])]
    if (waiters.length === 0 || types.length === 0) {
      return
    }
    // Snapshot ownership before the routed rows wake and remove their waiters.
    queueMicrotask(() => {
      const liveWaiters = this.deps.getMessageWaiters(mailboxHandle)
      for (const waiter of waiters) {
        if (
          liveWaiters?.has(waiter) &&
          (!waiter.typeFilter || types.some((type) => waiter.typeFilter?.includes(type)))
        ) {
          this.deps.resolveMessageWaiter(waiter)
        }
      }
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
    try {
      const leaf = this.deps.getLiveLeafForHandle(handle)
      return {
        mailboxHandle: this.deps.mailboxOwner.resolve(leaf, handle, {
          requireRequestedMail: true
        }),
        forwarded: this.deps.mailboxOwner.routeForeignDirectMessages(leaf)
      }
    } catch {
      return this.resolveDetachedMailbox(handle)
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
