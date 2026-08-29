import { isCursorAgentTitle } from '../../../shared/agent-detection'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import {
  hasUnfilteredOrchestrationWaiter,
  messageTypeHasOrchestrationWaiter,
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'

export type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

type PointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  mailboxOwner: OrchestrationMailboxOwner
  deliveryTarget: OrchestrationMailboxDeliveryTarget
  getDb: () => OrchestrationDb | null
  getLeaf: (leafKey: string) => OrchestrationMailboxLeaf | undefined
  getLeafKey: (tabId: string, leafId: string) => string
  getLiveLeafForHandle: (handle: string) => OrchestrationMailboxLeaf
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  getTabTitle: (tabId: string) => string | null | undefined
  getTerminalHandleForLeafKey: (leafKey: string) => string | undefined
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  writePty: (ptyId: string, data: string) => boolean | Promise<boolean>
}

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    const terminalHandle = this.deps.deliveryTarget.resolveTerminalHandle(handle)
    if (!terminalHandle) {
      return
    }
    try {
      const leaf = this.deps.getLiveLeafForHandle(terminalHandle)
      if (leaf.lastAgentStatus !== 'idle' || !leaf.lastAgentStatusObservedLive) {
        return
      }
      const mailboxHandle = this.deps.mailboxOwner.resolve(leaf, handle)
      if (mailboxHandle) {
        this.deliver(leaf, { mailboxHandle, reservedTypes })
      }
    } catch {
      // Persisted mail remains available to explicit check or a later idle edge.
    }
  }

  deliver(
    leaf: OrchestrationMailboxLeaf,
    options: {
      mailboxHandle: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
    }
  ): void {
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
    if (!db || !mailboxHandle.startsWith('run:')) {
      return
    }
    if (!this.deps.getTerminalHandleForLeafKey(this.leafKey(leaf))) {
      return
    }
    if (db.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length))) {
      return
    }
    if (leaf.ptyId && this.state.hasFlight(leaf.ptyId)) {
      this.state.parkDelivery(leaf.ptyId, mailboxHandle, leaf, options.reservedTypes)
      return
    }
    if (this.state.hasActiveWatermark(mailboxHandle)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }

    const waiters = this.deps.getMessageWaiters(mailboxHandle)
    if (hasUnfilteredOrchestrationWaiter(waiters)) {
      return
    }
    const excludedTypes = new Set(options.reservedTypes)
    for (const waiter of waiters ?? []) {
      for (const type of waiter.typeFilter ?? []) {
        excludedTypes.add(type)
      }
    }
    const unread = db
      .getUndeliveredUnreadMessages(mailboxHandle, undefined, {
        excludeTypes: [...excludedTypes],
        limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
      })
      .filter(
        (message) =>
          !options.reservedTypes?.has(message.type) &&
          !messageTypeHasOrchestrationWaiter(waiters, message.type)
      )
      .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
    if (unread.length === 0 || !leaf.writable || !leaf.ptyId) {
      return
    }
    const newestSequence = unread.at(-1)?.sequence
    if (newestSequence === undefined) {
      return
    }
    if (
      !this.state.releaseSupersededWatermark(
        mailboxHandle,
        newestSequence,
        leaf.ptyId,
        this.leafKey(leaf)
      )
    ) {
      return
    }
    if (
      this.deps.deliveryTarget.deferForAbsenceProbe(
        leaf,
        mailboxHandle,
        options.skipAbsenceProbe,
        (probedLeaf, ptyId, probedMailbox) =>
          this.redeliverAfterProbe(probedLeaf, ptyId, probedMailbox)
      )
    ) {
      return
    }
    this.stagePointer(leaf, mailboxHandle, unread, newestSequence)
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId)
    if (flight?.enterTimer != null) {
      clearTimeout(flight.enterTimer)
    }
    if (flight?.stagedMessageIds.length) {
      this.deps.getDb()?.markAsUndelivered(flight.stagedMessageIds)
    }
    for (const mailboxHandle of releasedMailboxes) {
      this.redrive(mailboxHandle, true)
    }
  }

  private redeliverAfterProbe(
    leaf: OrchestrationMailboxLeaf,
    ptyId: string,
    mailboxHandle: string
  ): void {
    const currentLeaf = this.deps.getLeaf(this.leafKey(leaf))
    if (
      currentLeaf?.ptyId === ptyId &&
      currentLeaf.lastAgentStatus === 'idle' &&
      currentLeaf.lastAgentStatusObservedLive
    ) {
      this.deliver(currentLeaf, { mailboxHandle, skipAbsenceProbe: true })
    }
  }

  private stagePointer(
    leaf: OrchestrationMailboxLeaf,
    mailboxHandle: string,
    unread: readonly { id: string; type: string; sequence: number }[],
    newestSequence: number
  ): void {
    const ptyId = leaf.ptyId
    if (!ptyId) {
      return
    }
    const flight = this.state.beginFlight(ptyId)
    const writeResult = this.deps.writePty(
      ptyId,
      formatMessagePointer(unread.length, mailboxHandle)
    )
    if (typeof writeResult === 'boolean') {
      this.finishPointerWrite(
        leaf,
        mailboxHandle,
        unread,
        newestSequence,
        ptyId,
        flight,
        writeResult
      )
      return
    }
    void writeResult
      .then(
        (accepted) =>
          this.finishPointerWrite(
            leaf,
            mailboxHandle,
            unread,
            newestSequence,
            ptyId,
            flight,
            accepted
          ),
        () =>
          this.finishPointerWrite(leaf, mailboxHandle, unread, newestSequence, ptyId, flight, false)
      )
      .catch(() => undefined)
  }

  private finishPointerWrite(
    leaf: OrchestrationMailboxLeaf,
    mailboxHandle: string,
    unread: readonly { id: string; type: string; sequence: number }[],
    newestSequence: number,
    ptyId: string,
    flight: OrchestrationMailboxDeliveryFlight,
    accepted: boolean
  ): void {
    let delayedSettle = false
    try {
      if (!accepted || !this.state.isCurrentFlight(ptyId, flight)) {
        return
      }
      const db = this.deps.getDb()
      if (
        !db ||
        shouldReleaseOrchestrationPointer(
          db,
          mailboxHandle,
          unread,
          this.deps.getMessageWaiters(mailboxHandle)
        )
      ) {
        return
      }
      flight.stagedMessageIds = unread.map((message) => message.id)
      db.markAsDelivered(flight.stagedMessageIds)
      this.state.setWatermark(mailboxHandle, newestSequence, ptyId, this.leafKey(leaf))
      if (
        [leaf.lastOscTitle, leaf.paneTitle, this.deps.getTabTitle(leaf.tabId)].some(
          isCursorAgentTitle
        )
      ) {
        this.state.clearWatermark(mailboxHandle, newestSequence, ptyId)
        this.redrive(mailboxHandle)
        return
      }
      flight.enterTimer = setTimeout(
        () =>
          submitOrchestrationMailboxPointer(
            {
              mailboxOwner: this.deps.mailboxOwner,
              state: this.state,
              getDb: this.deps.getDb,
              getLeaf: this.deps.getLeaf,
              getLeafKey: this.deps.getLeafKey,
              getMessageWaiters: this.deps.getMessageWaiters,
              isLeafPtyProvenAbsent: this.deps.isLeafPtyProvenAbsent,
              writePty: this.deps.writePty,
              settle: (settledPtyId, settledFlight) => this.settle(settledPtyId, settledFlight),
              redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
            },
            { leaf, mailboxHandle, messages: unread, newestSequence, ptyId, flight }
          ),
        500
      )
      delayedSettle = true
    } finally {
      if (!delayedSettle) {
        this.settle(ptyId, flight)
      }
    }
  }

  private settle(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): void {
    const parked = this.state.settleFlight(ptyId, flight)
    if (!parked) {
      return
    }
    for (const [mailboxHandle, delivery] of parked) {
      const currentLeaf = this.deps.getLeaf(this.leafKey(delivery.leaf))
      if (
        currentLeaf?.ptyId !== ptyId ||
        this.deps.mailboxOwner.resolve(currentLeaf, mailboxHandle) !== mailboxHandle
      ) {
        this.parkRedelivery(mailboxHandle, delivery.reservedTypes)
        this.redrive(mailboxHandle)
      } else {
        this.deliver(currentLeaf, { mailboxHandle, reservedTypes: delivery.reservedTypes })
      }
    }
  }

  private redrive(mailboxHandle: string, force = false): void {
    const parkedTypes = this.state.takeRedelivery(mailboxHandle, force)
    if (parkedTypes === undefined) {
      return
    }
    queueMicrotask(() => {
      try {
        this.deps.redriveMailbox(mailboxHandle, parkedTypes ?? undefined)
      } catch {
        // Durable mail remains available to explicit check or a later idle edge.
      }
    })
  }

  private leafKey(leaf: OrchestrationMailboxLeaf): string {
    return this.deps.getLeafKey(leaf.tabId, leaf.leafId)
  }
}
