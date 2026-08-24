import { isCursorAgentTitle } from '../../../shared/agent-detection'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db'
import { formatMessagePointer } from './formatter'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  hasUnfilteredOrchestrationWaiter,
  messageTypeHasOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight
} from './mailbox-pointer-state'
import { redriveMailboxPointer } from './mailbox-pointer-redrive'
import {
  assertMailboxPointerDeliveryCurrent,
  markMailboxDeliveryDelivered
} from './mailbox-pointer-delivery-validation'
export type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
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
    } catch {}
  }
  deliver(
    leaf: OrchestrationMailboxLeaf,
    options: {
      mailboxHandle: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
    }
  ): void {
    const terminalHandle = this.deps.getTerminalHandleForLeaf(leaf)
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
    if (!db || !mailboxHandle.startsWith('run:') || !terminalHandle) {
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
      this.state.parkRedelivery(mailboxHandle, options.reservedTypes)
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
        this.deps.getLeafKey(leaf.tabId, leaf.leafId)
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
    this.stagePointer(leaf, terminalHandle, mailboxHandle, unread, newestSequence)
  }
  retirePty(ptyId: string): void {
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId)
    flight?.abortController.abort()
    for (const mailboxHandle of releasedMailboxes) {
      this.redrive(mailboxHandle, true)
    }
  }
  private redeliverAfterProbe(
    leaf: OrchestrationMailboxLeaf,
    ptyId: string,
    mailboxHandle: string
  ): void {
    const currentLeaf = this.deps.getLeaf(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
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
    terminalHandle: string,
    mailboxHandle: string,
    unread: readonly { id: string; type: string; sequence: number }[],
    newestSequence: number
  ): void {
    const ptyId = leaf.ptyId
    if (!ptyId) {
      return
    }
    const flight = this.state.beginFlight(ptyId)
    void this.deps
      .sendPrompt(terminalHandle, formatMessagePointer(unread.length, mailboxHandle), {
        signal: flight.abortController.signal,
        beforeWrite: () =>
          assertMailboxPointerDeliveryCurrent(
            this.deps,
            this.state,
            leaf,
            mailboxHandle,
            unread,
            ptyId,
            flight
          ),
        beforeAttempt: () =>
          this.stagePromptDeliveryAttempt(
            leaf,
            mailboxHandle,
            unread,
            newestSequence,
            ptyId,
            flight
          )
      })
      .then((outcome) =>
        this.finishPromptDelivery(leaf, mailboxHandle, newestSequence, ptyId, flight, outcome)
      )
      .catch(() =>
        this.finishPromptDelivery(leaf, mailboxHandle, newestSequence, ptyId, flight, 'rejected')
      )
      .catch(() => undefined)
  }
  private finishPromptDelivery(
    leaf: OrchestrationMailboxLeaf,
    mailboxHandle: string,
    newestSequence: number,
    ptyId: string,
    flight: OrchestrationMailboxDeliveryFlight,
    outcome: 'delivered' | 'unknown' | 'rejected'
  ): void {
    try {
      if (!flight.mutated || !this.state.isCurrentFlight(ptyId, flight)) {
        return
      }
      const messageIds = flight.messageIds
      if (outcome === 'delivered' && messageIds.length > 0) {
        const db = this.deps.getDb()
        if (db?.markAsDelivered && !flight.usedLegacyDeliveredTransition) {
          markMailboxDeliveryDelivered(db, messageIds, flight.usedLegacyDeliveredTransition)
        }
      }
      if (
        outcome === 'delivered' &&
        [leaf.lastOscTitle, leaf.paneTitle, this.deps.getTabTitle(leaf.tabId)].some(
          isCursorAgentTitle
        )
      ) {
        this.state.clearWatermark(mailboxHandle, newestSequence, ptyId)
        this.redrive(mailboxHandle)
        return
      }
      if (outcome !== 'delivered' && messageIds.length > 0) {
        const db = this.deps.getDb()
        if (outcome === 'rejected') {
          db?.markAsUndelivered?.(messageIds)
        } else {
          ;(db?.markAsDeliveryUnknown ?? db?.markAsDelivered)?.call(db, messageIds)
        }
      }
      const released =
        outcome === 'unknown'
          ? this.state.deactivateWatermark(mailboxHandle, newestSequence, ptyId)
          : this.state.clearWatermark(mailboxHandle, newestSequence, ptyId)
      if (released && outcome !== 'unknown') {
        this.redrive(mailboxHandle)
      }
    } finally {
      this.settle(ptyId, flight)
      if (flight.redriveMailbox) {
        this.redrive(flight.redriveMailbox, true)
      }
    }
  }
  private stagePromptDeliveryAttempt(
    leaf: OrchestrationMailboxLeaf,
    mailboxHandle: string,
    unread: readonly { id: string; type: string; sequence: number }[],
    newestSequence: number,
    ptyId: string,
    flight: OrchestrationMailboxDeliveryFlight
  ): void {
    const db = this.deps.getDb()
    if (!db) {
      throw new Error('orchestration_db_unavailable')
    }
    const stage = db.markAsDeliveryStaged ?? db.markAsDelivered
    flight.usedLegacyDeliveredTransition = !db.markAsDeliveryStaged
    stage.call(
      db,
      unread.map((message) => message.id)
    )
    flight.messageIds = unread.map((message) => message.id)
    this.state.setWatermark(
      mailboxHandle,
      newestSequence,
      ptyId,
      this.deps.getLeafKey(leaf.tabId, leaf.leafId)
    )
    flight.mutated = true
    if (!this.state.isCurrentFlight(ptyId, flight)) {
      this.state.deactivateWatermark(mailboxHandle, newestSequence, ptyId)
    }
    assertMailboxPointerDeliveryCurrent(
      this.deps,
      this.state,
      leaf,
      mailboxHandle,
      unread,
      ptyId,
      flight
    )
    if (
      [leaf.lastOscTitle, leaf.paneTitle, this.deps.getTabTitle(leaf.tabId)].some(
        isCursorAgentTitle
      )
    ) {
      flight.abortController.abort()
    }
  }
  private settle(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): void {
    const parked = this.state.settleFlight(ptyId, flight)
    if (!parked) {
      return
    }
    for (const [mailboxHandle, delivery] of parked) {
      const currentLeaf = this.deps.getLeaf(
        this.deps.getLeafKey(delivery.leaf.tabId, delivery.leaf.leafId)
      )
      if (
        currentLeaf?.ptyId !== ptyId ||
        this.deps.mailboxOwner.resolve(currentLeaf, mailboxHandle) !== mailboxHandle
      ) {
        this.state.parkRedelivery(mailboxHandle, delivery.reservedTypes)
        this.redrive(mailboxHandle)
      } else {
        this.deliver(currentLeaf, { mailboxHandle, reservedTypes: delivery.reservedTypes })
      }
    }
  }
  private redrive(mailboxHandle: string, force = false): void {
    redriveMailboxPointer(this.state, this.deps, mailboxHandle, force)
  }
}
