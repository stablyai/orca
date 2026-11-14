import { MailboxForegroundDelivery } from './mailbox-foreground-delivery'
import type {
  PointerDeliveryDependencies,
  PointerDeliveryOptions
} from './mailbox-pointer-delivery-contract'
import {
  hasPendingMailboxPointerFlight,
  resumeDeferredMailboxPointer,
  hasUnfilteredOrchestrationWaiter,
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import {
  OrchestrationMailboxPointerState,
  type OrchestrationMailboxDeliveryFlight
} from './mailbox-pointer-state'
import {
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from '../../db/messages/mailbox-pointer-enter-state'
import {
  reconcilePendingOrchestrationMailboxPointer,
  reconcileUncertainMailboxPointers
} from './mailbox-pointer-resume'
import { stageOrchestrationMailboxPointer, pointerEnterDelayMs } from './mailbox-pointer-stage'

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState((ptyId) => {
    this.deps.onDeliveryDecision(ptyId, { reset: true })
    queueMicrotask(() => this.deps.redriveTerminal(ptyId))
  })
  private readonly foregroundDelivery = new MailboxForegroundDelivery()
  private readonly coldParkedPtys = new Set<string>()
  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.foregroundDelivery.deliverForHandle(this.deps, this, handle, reservedTypes)
  }

  deliver(terminal: OrchestrationMailboxTerminal, options: PointerDeliveryOptions): void {
    try {
      const db = this.deps.getDb()
      const { mailboxHandle, foreground, agent } = options
      const isOwnDirectMailbox = mailboxHandle === terminal.handle
      if (
        !db ||
        (!isOwnDirectMailbox &&
          !mailboxHandle.startsWith('run:') &&
          !mailboxHandle.startsWith('dispatch:'))
      ) {
        return
      }
      const { ptyId } = terminal
      const target = this.deps.resolveSubmitTarget(ptyId, foreground, undefined, agent)
      if (!target) {
        return
      }
      terminal = target.terminal
      if (this.resumeDeferredEnter(terminal, options)) {
        this.state.parkDelivery(ptyId, mailboxHandle, options.reservedTypes)
        return
      }
      const foregroundHeld =
        options.foreground === undefined &&
        (this.needsForegroundEvaluation(ptyId) || this.deps.isForegroundCandidate?.(terminal))
      if (
        (!foregroundHeld &&
          (!isMailboxTerminalTakingInput(terminal) ||
            !this.deps.isAgentSettledForDelivery(ptyId, foreground, undefined, agent))) ||
        this.state.hasActiveWatermark(mailboxHandle)
      ) {
        this.parkRedelivery(mailboxHandle, options.reservedTypes)
        return
      }

      const waiters = this.deps.getMessageWaiters(mailboxHandle)
      if (hasUnfilteredOrchestrationWaiter(waiters)) {
        return
      }
      const pending = db.getPendingMailboxPointerMessages(mailboxHandle)
      const { messages: unread, heldDeliveryId } = selectOrchestrationPointerBatch({
        db,
        mailboxHandle,
        waiters,
        reservedTypes: options.reservedTypes,
        excludeRunOwnedDirect: isOwnDirectMailbox
      })
      const retained = reconcilePendingOrchestrationMailboxPointer({
        deps: this.deps,
        terminal,
        messages: pending,
        hasEligibleMail: unread.length > 0,
        reconcile: () => this.reconcileUncertainMail(ptyId),
        redrive: () => this.redrive(mailboxHandle, true)
      })
      const newestSequence = unread.at(-1)?.sequence ?? pending.at(-1)?.sequence
      if (newestSequence !== undefined && unread.length > 0) {
        if (this.state.noteMailSequence(ptyId, newestSequence)) {
          this.deps.onDeliveryDecision(ptyId, { reset: true })
        }
        if (
          this.deps.deliveryTarget.deferForAbsenceProbe(
            ptyId,
            mailboxHandle,
            options.skipAbsenceProbe,
            (probedMailbox) => this.redeliverAfterProbe(ptyId, probedMailbox)
          )
        ) {
          return
        }
        if (this.foregroundDelivery.defer(this.deps, this, ptyId, options, target)) {
          return
        }
      }
      if (
        newestSequence === undefined ||
        unread.length === 0 ||
        (retained && this.deps.readComposerText?.(ptyId, agent) !== '')
      ) {
        return
      }
      if (!this.state.releaseSupersededWatermark(mailboxHandle, newestSequence, ptyId)) {
        return
      }
      if (
        this.deps.mailboxOwner.resolve(terminal, mailboxHandle, { routeDirectMail: false }) !==
        mailboxHandle
      ) {
        this.parkRedelivery(mailboxHandle, options.reservedTypes)
        this.redrive(mailboxHandle)
        return
      }
      stageOrchestrationMailboxPointer({
        deps: this.deps,
        state: this.state,
        terminal,
        agent: options.agent,
        mailboxHandle,
        messages: unread,
        heldDeliveryId,
        newestSequence,
        enterDelayMs: pointerEnterDelayMs(),
        settle: (ptyId, flight) => this.settle(ptyId, flight),
        onUncertainDelivery: (ptyId) => this.reconcileUncertainMail(ptyId),
        redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
      })
    } finally {
      this.deps.onDeliveryDecision(terminal.ptyId)
    }
  }

  private needsForegroundEvaluation(ptyId: string): boolean {
    return this.isForegroundHeld(ptyId) || this.deps.needsForegroundEvaluation?.(ptyId) === true
  }

  readonly probeForeground = (ptyId: string, processIncarnation: string) => {
    const probe = this.state.foreground.probeForeground(ptyId, processIncarnation, () =>
      this.deps.readForeground(ptyId)
    )
    this.deps.onDeliveryDecision(ptyId)
    return probe
  }

  readonly applyForeground = this.state.foreground.applyForeground.bind(this.state.foreground)

  stagedPointerText(ptyId: string): string | undefined {
    return this.state.stagedPointerText(ptyId)
  }

  requiresCurrentScreen(ptyId: string): boolean {
    const incarnation = this.state.foreground.screenRecovery(ptyId)
    return (
      incarnation !== undefined &&
      incarnation === this.deps.resolveSubmitTarget(ptyId)?.processIncarnation
    )
  }

  reconcileUncertainMail(ptyId: string): void {
    reconcileUncertainMailboxPointers(this.deps, this.state, ptyId)
  }

  completeRecovery(ptyId: string): void {
    this.state.completeRecovery(ptyId)
  }

  readonly hasPendingFlightMail = (terminal: OrchestrationMailboxTerminal): boolean =>
    this.state.hasRecoveryFlight(terminal.ptyId) ||
    hasPendingMailboxPointerFlight(this.deps, terminal, this.state.flightForPty(terminal.ptyId))

  resumeDeferredEnter(
    terminal: OrchestrationMailboxTerminal,
    options?: PointerDeliveryOptions
  ): boolean {
    return resumeDeferredMailboxPointer(
      this.deps,
      this.state,
      terminal,
      this.coldParkedPtys.has(terminal.ptyId),
      options
    )
  }

  isDeliveryInFlight(ptyId: string): boolean {
    return this.state.hasActiveFlight(ptyId) || this.state.foreground.hasForegroundProbe(ptyId)
  }

  captureForegroundObservation(ptyId: string) {
    const processIncarnation = this.deps.resolveSubmitTarget(ptyId)?.processIncarnation
    return processIncarnation
      ? this.state.foreground.captureForegroundObservation(ptyId, processIncarnation)
      : undefined
  }

  isForegroundHeld(ptyId: string): boolean {
    const hold = this.state.foreground.foregroundHold(ptyId)
    if (hold && hold !== this.deps.resolveSubmitTarget(ptyId)?.processIncarnation) {
      this.state.foreground.retirePty(ptyId)
      return false
    }
    return !!hold
  }

  observeTerminal(ptyId: string, status?: string): void {
    if (this.state.foreground.observeTerminal(ptyId, status)) {
      this.deps.onDeliveryDecision(ptyId, { reset: true })
      queueMicrotask(() => this.deps.redriveTerminal(ptyId))
    }
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string, preserveForeground = false): void {
    this.coldParkedPtys.delete(ptyId)
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId, preserveForeground)
    if (!preserveForeground) {
      this.deps.onDeliveryDecision(ptyId, { foreground: false, uncertainMailboxes: [] })
    }
    if (flight?.enterTimer != null) {
      clearTimeout(flight.enterTimer)
    }
    if (flight?.stagedMessageIds.length) {
      const db = this.deps.getDb()
      if (db && flight.processIncarnation) {
        // Release only phases that provably never sent Enter; an attempted Enter may already have landed.
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

  observeAgentWorking(ptyId: string): void {
    try {
      // Staged pointer text is already queued in the composer; working is queue-safe.
      if (this.state.hasFlight(ptyId)) {
        if (this.coldParkedPtys.has(ptyId)) {
          this.state.deferFlightUntilIdle(ptyId)
        }
        return
      }
      this.retirePty(ptyId, true)
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

  private redeliverAfterProbe(ptyId: string, mailboxHandle: string): void {
    const current = this.deps.getTerminal(ptyId)
    if (current) {
      this.deliver(current, { mailboxHandle, skipAbsenceProbe: true })
    }
  }

  private settle(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): void {
    const parked = this.state.settleFlight(ptyId, flight)
    this.deps.onDeliveryDecision(ptyId, { settled: true, reset: true })
    const current = this.deps.getTerminal(ptyId)
    for (const [mailboxHandle, reservedTypes] of parked ?? []) {
      if (current) {
        this.deliver(current, { mailboxHandle, reservedTypes })
      } else {
        this.parkRedelivery(mailboxHandle, reservedTypes)
        this.redrive(mailboxHandle)
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
