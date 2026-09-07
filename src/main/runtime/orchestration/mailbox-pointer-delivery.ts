import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  hasUnfilteredOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight
} from './mailbox-pointer-state'
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'

export type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

const DEFAULT_POINTER_ENTER_DELAY_MS = 500

function pointerEnterDelayMs(): number {
  const configured = Number(process.env.ORCA_E2E_ORCHESTRATION_POINTER_ENTER_DELAY_MS)
  return Number.isFinite(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : DEFAULT_POINTER_ENTER_DELAY_MS
}

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  private readonly coldParkedPtys = new Set<string>()
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
    if (!db || (!mailboxHandle.startsWith('run:') && !mailboxHandle.startsWith('dispatch:'))) {
      return
    }
    if (!this.deps.getTerminalHandleForLeafKey(this.leafKey(leaf))) {
      return
    }
    if (db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
      return
    }
    if (leaf.ptyId) {
      const deferredEnter = this.state.takeDeferredEnter(leaf.ptyId)
      if (deferredEnter) {
        this.state.parkDelivery(leaf.ptyId, mailboxHandle, leaf, options.reservedTypes)
        deferredEnter()
        return
      }
      if (this.state.hasFlight(leaf.ptyId)) {
        this.state.parkDelivery(leaf.ptyId, mailboxHandle, leaf, options.reservedTypes)
        return
      }
    }
    if (this.state.hasActiveWatermark(mailboxHandle)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }

    const waiters = this.deps.getMessageWaiters(mailboxHandle)
    if (hasUnfilteredOrchestrationWaiter(waiters)) {
      return
    }
    const pending = db.getPendingMailboxPointerMessages(mailboxHandle)
    if (
      pending.length > 0 &&
      resumePendingOrchestrationMailboxPointer({
        deps: this.deps,
        state: this.state,
        leaf,
        mailboxHandle,
        messages: pending,
        enterDelayMs: pointerEnterDelayMs(),
        leafKey: this.leafKey(leaf),
        settle: (ptyId, flight) => this.settle(ptyId, flight),
        redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
      })
    ) {
      return
    }
    // Every waiter here is type-filtered (unfiltered ones returned above), so SQL exclusion is exact.
    const excludedTypes = new Set(options.reservedTypes)
    for (const waiter of waiters ?? []) {
      for (const type of waiter.typeFilter ?? []) {
        excludedTypes.add(type)
      }
    }
    const unread = db.getUndeliveredUnreadMessages(mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
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
    stageOrchestrationMailboxPointer({
      deps: this.deps,
      state: this.state,
      leaf,
      mailboxHandle,
      messages: unread,
      newestSequence,
      enterDelayMs: pointerEnterDelayMs(),
      leafKey: this.leafKey(leaf),
      settle: (ptyId, flight) => this.settle(ptyId, flight),
      redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
    })
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    this.coldParkedPtys.delete(ptyId)
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

  observeAgentWorking(ptyId: string): void {
    try {
      // Staged pointer text is already queued in the composer; working is queue-safe.
      if (this.state.hasFlight(ptyId)) {
        if (this.coldParkedPtys.has(ptyId)) {
          this.state.deferFlightUntilIdle(ptyId)
        }
        return
      }
      this.retirePty(ptyId)
      this.deps.getDb()?.releasePendingMailboxPointerForPty(ptyId)
    } catch {
      // Runtime teardown can close the DB before the final PTY frame is drained.
    }
  }

  observeAgentIdle(ptyId: string): void {
    if (this.coldParkedPtys.has(ptyId)) {
      this.state.deferFlightUntilIdle(ptyId)
    }
    this.state.takeDeferredEnter(ptyId)?.()
  }

  markPtyColdParked(ptyId: string): void {
    this.coldParkedPtys.add(ptyId)
  }

  clearPtyColdParked(ptyId: string): void {
    this.coldParkedPtys.delete(ptyId)
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
