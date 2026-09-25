import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  hasUnfilteredOrchestrationWaiter,
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import {
  OrchestrationMailboxPointerHandleDelivery,
  type OrchestrationMailboxPointerDeliveryOptions
} from './mailbox-pointer-handle-delivery'
import { pointerEnterDelayMs } from './mailbox-pointer-enter-delay'
import { OrchestrationMailboxStatuslessCodexProofCoordinator } from './mailbox-statusless-codex-proof-coordinator'
import { OrchestrationMailboxStatuslessCodexRedrive } from './mailbox-statusless-codex-redrive'
import { isStatuslessIdleProofCurrent } from './mailbox-statusless-idle-proof'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight,
  type OrchestrationStatuslessIdleProof
} from './mailbox-pointer-state'
import {
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'

export type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  private readonly coldParkedPtys = new Set<string>()
  private readonly statuslessCodexProofs: OrchestrationMailboxStatuslessCodexProofCoordinator
  private readonly statuslessCodexRedrives: OrchestrationMailboxStatuslessCodexRedrive
  private readonly handleDelivery: OrchestrationMailboxPointerHandleDelivery<TWaiter>

  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {
    this.statuslessCodexProofs = new OrchestrationMailboxStatuslessCodexProofCoordinator(deps)
    this.statuslessCodexRedrives = new OrchestrationMailboxStatuslessCodexRedrive((mailboxHandle) =>
      this.redrive(mailboxHandle, true)
    )
    this.handleDelivery = new OrchestrationMailboxPointerHandleDelivery(
      deps,
      this.statuslessCodexProofs,
      (leaf, options) => this.deliver(leaf, options)
    )
  }

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.handleDelivery.deliverForHandle(handle, reservedTypes)
  }

  deliver(
    leaf: OrchestrationMailboxLeaf,
    options: OrchestrationMailboxPointerDeliveryOptions
  ): void {
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
    if (!db || (!mailboxHandle.startsWith('run:') && !mailboxHandle.startsWith('dispatch:'))) {
      return
    }
    if (!this.deps.getTerminalHandleForLeafKey(this.leafKey(leaf))) {
      return
    }
    if (
      options.statuslessIdleProof &&
      !isStatuslessIdleProofCurrent(
        leaf,
        options.statuslessIdleProof,
        this.deps.getTerminalProcessIncarnation
      )
    ) {
      return
    }
    if (db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
      return
    }
    // Why the gate lives HERE and not at each caller: this method is the single point at
    // which this subsystem commits to typing the pointer into the pane, and it has four
    // callers (handle delivery, post-probe redelivery, flight settle, and the notification
    // coordinator's per-leaf path). Gating callers meant each new one silently bypassed the
    // check; gating the commit point cannot be bypassed. Refusal parks and re-offers rather
    // than dropping — `isAgentSettledForDelivery` arms the re-check.
    if (!this.deps.isAgentSettledForDelivery(leaf)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }
    if (leaf.ptyId) {
      const deferredEnter = this.state.takeDeferredEnter(leaf.ptyId)
      if (deferredEnter) {
        this.state.parkDelivery(
          leaf.ptyId,
          mailboxHandle,
          leaf,
          options.reservedTypes,
          options.statuslessIdleProof
        )
        deferredEnter()
        return
      }
      if (this.state.hasFlight(leaf.ptyId)) {
        this.state.parkDelivery(
          leaf.ptyId,
          mailboxHandle,
          leaf,
          options.reservedTypes,
          options.statuslessIdleProof
        )
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
    const unread = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters,
      reservedTypes: options.reservedTypes
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
          this.redeliverAfterProbe(probedLeaf, ptyId, probedMailbox, options.statuslessIdleProof)
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
      ...(options.statuslessIdleProof ? { statuslessIdleProof: options.statuslessIdleProof } : {}),
      ...(this.deps.submitStatuslessCodexPointer
        ? {
            deferRedriveUntilPtyOutput: (ptyId: string, redriveMailbox: string, sequence: number) =>
              this.statuslessCodexRedrives.schedule(ptyId, redriveMailbox, sequence),
            clearDeferredOutputRedrive: (ptyId: string, redriveMailbox: string, sequence: number) =>
              this.statuslessCodexRedrives.clear(ptyId, redriveMailbox, sequence)
          }
        : {}),
      settle: (ptyId, flight) => this.settle(ptyId, flight),
      redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
    })
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    this.coldParkedPtys.delete(ptyId)
    this.statuslessCodexProofs.retirePty(ptyId)
    this.statuslessCodexRedrives.retirePty(ptyId)
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId)
    if (flight?.enterTimer != null) {
      clearTimeout(flight.enterTimer)
    }
    if (flight?.stagedMessageIds.length) {
      const db = this.deps.getDb()
      if (db && flight.processIncarnation) {
        // Why: the Enter timer was just cleared, so a reserved or merely-written pointer provably
        // never submitted and is released. An attempted Enter may already have landed, so it stays
        // at its phase for the resume path to revalidate rather than being sent a second time.
        db.releaseMailboxPointerEnter(
          flight.stagedMessageIds,
          { ptyId, processIncarnation: flight.processIncarnation },
          [MAILBOX_POINTER_RESERVED, MAILBOX_POINTER_WRITE_ATTEMPTED]
        )
      } else {
        db?.markAsUndelivered(flight.stagedMessageIds)
      }
    }
    for (const mailboxHandle of releasedMailboxes) {
      this.redrive(mailboxHandle, true)
    }
  }

  redriveAfterPtyOutput(ptyId: string): void {
    this.statuslessCodexRedrives.handlePtyOutput(ptyId)
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
    mailboxHandle: string,
    statuslessIdleProof?: OrchestrationStatuslessIdleProof
  ): void {
    const currentLeaf = this.deps.getLeaf(this.leafKey(leaf))
    if (
      currentLeaf?.ptyId === ptyId &&
      ((currentLeaf.lastAgentStatus === 'idle' && currentLeaf.lastAgentStatusObservedLive) ||
        (statuslessIdleProof &&
          isStatuslessIdleProofCurrent(
            currentLeaf,
            statuslessIdleProof,
            this.deps.getTerminalProcessIncarnation
          )))
    ) {
      this.deliver(currentLeaf, {
        mailboxHandle,
        skipAbsenceProbe: true,
        ...(statuslessIdleProof ? { statuslessIdleProof } : {})
      })
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
        this.deliver(currentLeaf, {
          mailboxHandle,
          reservedTypes: delivery.reservedTypes,
          ...(delivery.statuslessIdleProof
            ? { statuslessIdleProof: delivery.statuslessIdleProof }
            : {})
        })
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
