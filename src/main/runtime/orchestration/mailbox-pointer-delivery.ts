import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import { getOrchestrationMailboxPointerCandidates } from './mailbox-pointer-candidates'
import { OrchestrationMailboxStatuslessCodexProofCoordinator } from './mailbox-statusless-codex-proof-coordinator'
import { OrchestrationMailboxStatuslessCodexRedrive } from './mailbox-statusless-codex-redrive'
import { isStatuslessIdleProofCurrent } from './mailbox-statusless-idle-proof'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import type { SubmitStatuslessCodexPointer } from './mailbox-statusless-codex-submit'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight,
  type OrchestrationStatuslessIdleProof
} from './mailbox-pointer-state'

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
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  proveStatuslessCodexIdle?: (terminalHandle: string, ptyId: string) => Promise<string | null>
  redriveMailbox: (mailboxHandle: string, reservedTypes?: ReadonlySet<string>) => void
  /** Ask for an auto-slept recipient to be woken. Optional so hosts that predate
   *  the wake path keep today's silent give-up. */
  requestSleepingRecipientWake?: (mailboxHandle: string) => void
  submitStatuslessCodexPointer?: SubmitStatuslessCodexPointer
  writePty: (ptyId: string, data: string) => boolean | Promise<boolean>
}

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  private readonly statuslessCodexProofs: OrchestrationMailboxStatuslessCodexProofCoordinator
  private readonly statuslessCodexRedrives: OrchestrationMailboxStatuslessCodexRedrive

  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {
    this.statuslessCodexProofs = new OrchestrationMailboxStatuslessCodexProofCoordinator(deps)
    this.statuslessCodexRedrives = new OrchestrationMailboxStatuslessCodexRedrive((mailboxHandle) =>
      this.redrive(mailboxHandle, true)
    )
  }

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    const terminalHandle = this.deps.deliveryTarget.resolveTerminalHandle(handle)
    if (!terminalHandle) {
      // No live pane owns this mailbox. The message arriving is itself the
      // evidence the recipient is owed work, so ask for a wake rather than
      // leaving the mail to an idle edge that a slept pane will never reach.
      this.deps.requestSleepingRecipientWake?.(handle)
      return
    }
    try {
      const leaf = this.deps.getLiveLeafForHandle(terminalHandle)
      // Why before the status check: a leaf with no PTY still resolves once the
      // pane is listable, and its status reads the same as a busy pane's. Waiting
      // for an idle edge that no process will ever emit is the silent give-up
      // this path exists to end, so treat "no process" as the wake evidence.
      if (!leaf.ptyId) {
        this.deps.requestSleepingRecipientWake?.(handle)
        return
      }
      if (leaf.lastAgentStatus === 'idle' && leaf.lastAgentStatusObservedLive) {
        const mailboxHandle = this.deps.mailboxOwner.resolve(leaf, handle)
        if (mailboxHandle) {
          this.deliver(leaf, { mailboxHandle, reservedTypes })
        }
        return
      }
      if (leaf.lastAgentStatus !== null) {
        return
      }
      const mailboxHandle = this.deps.mailboxOwner.resolve(leaf, handle)
      const db = this.deps.getDb()
      if (
        !db ||
        !mailboxHandle?.startsWith('run:') ||
        db.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length)) ||
        getOrchestrationMailboxPointerCandidates(
          db,
          mailboxHandle,
          this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes
        ).length === 0
      ) {
        return
      }
      this.statuslessCodexProofs.runWhenProven(
        terminalHandle,
        leaf,
        (currentLeaf, statuslessIdleProof) => {
          const currentMailbox = this.deps.mailboxOwner.resolve(currentLeaf, handle)
          if (currentMailbox === mailboxHandle) {
            this.deliver(currentLeaf, {
              mailboxHandle,
              reservedTypes,
              statuslessIdleProof
            })
          }
        }
      )
    } catch {
      // Persisted mail remains available to explicit check or a later idle edge.
      this.deps.requestSleepingRecipientWake?.(handle)
    }
  }

  deliver(
    leaf: OrchestrationMailboxLeaf,
    options: {
      mailboxHandle: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
      statuslessIdleProof?: OrchestrationStatuslessIdleProof
    }
  ): void {
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
    if (!db || !mailboxHandle.startsWith('run:')) {
      return
    }
    if (!this.deps.getTerminalHandleForLeafKey(this.deps.getLeafKey(leaf.tabId, leaf.leafId))) {
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
    if (db.hasOutstandingRunDelivery?.(mailboxHandle.slice('run:'.length))) {
      return
    }
    if (leaf.ptyId && this.state.hasFlight(leaf.ptyId)) {
      this.state.parkDelivery(
        leaf.ptyId,
        mailboxHandle,
        leaf,
        options.reservedTypes,
        options.statuslessIdleProof
      )
      return
    }
    if (this.state.hasActiveWatermark(mailboxHandle)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }

    const unread = getOrchestrationMailboxPointerCandidates(
      db,
      mailboxHandle,
      this.deps.getMessageWaiters(mailboxHandle),
      options.reservedTypes
    )
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
    stageOrchestrationMailboxPointer(
      {
        mailboxOwner: this.deps.mailboxOwner,
        state: this.state,
        getDb: this.deps.getDb,
        getLeaf: this.deps.getLeaf,
        getLeafKey: this.deps.getLeafKey,
        getMessageWaiters: this.deps.getMessageWaiters,
        getTabTitle: this.deps.getTabTitle,
        getTerminalProcessIncarnation: this.deps.getTerminalProcessIncarnation,
        isLeafPtyProvenAbsent: this.deps.isLeafPtyProvenAbsent,
        ...(this.deps.requestSleepingRecipientWake
          ? { requestSleepingRecipientWake: this.deps.requestSleepingRecipientWake }
          : {}),
        ...(this.deps.submitStatuslessCodexPointer
          ? {
              submitStatuslessCodexPointer: this.deps.submitStatuslessCodexPointer,
              deferRedriveUntilPtyOutput: (
                ptyId: string,
                mailboxHandle: string,
                sequence: number
              ) => this.statuslessCodexRedrives.schedule(ptyId, mailboxHandle, sequence),
              clearDeferredOutputRedrive: (
                ptyId: string,
                mailboxHandle: string,
                sequence: number
              ) => this.statuslessCodexRedrives.clear(ptyId, mailboxHandle, sequence)
            }
          : {}),
        writePty: this.deps.writePty,
        settle: (settledPtyId, settledFlight) => this.settle(settledPtyId, settledFlight),
        redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
      },
      {
        leaf,
        mailboxHandle,
        unread,
        newestSequence,
        statuslessIdleProof: options.statuslessIdleProof
      }
    )
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    this.statuslessCodexProofs.retirePty(ptyId)
    this.statuslessCodexRedrives.retirePty(ptyId)
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

  redriveAfterPtyOutput(ptyId: string): void {
    this.statuslessCodexRedrives.handlePtyOutput(ptyId)
  }

  private redeliverAfterProbe(
    leaf: OrchestrationMailboxLeaf,
    ptyId: string,
    mailboxHandle: string,
    statuslessIdleProof?: OrchestrationStatuslessIdleProof
  ): void {
    const currentLeaf = this.deps.getLeaf(this.deps.getLeafKey(leaf.tabId, leaf.leafId))
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
        statuslessIdleProof
      })
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
        this.parkRedelivery(mailboxHandle, delivery.reservedTypes)
        this.redrive(mailboxHandle)
      } else {
        this.deliver(currentLeaf, {
          mailboxHandle,
          reservedTypes: delivery.reservedTypes,
          statuslessIdleProof: delivery.statuslessIdleProof
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
}
