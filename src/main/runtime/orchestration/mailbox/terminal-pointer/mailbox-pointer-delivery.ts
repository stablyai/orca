import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
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
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'

const DEFAULT_POINTER_ENTER_DELAY_MS = 500

function pointerEnterDelayMs(): number {
  const configured = Number(process.env.ORCA_E2E_ORCHESTRATION_POINTER_ENTER_DELAY_MS)
  return Number.isFinite(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : DEFAULT_POINTER_ENTER_DELAY_MS
}

export class OrchestrationMailboxPointerDelivery<TWaiter extends OrchestrationMessageWaiter> {
  private readonly state = new OrchestrationMailboxPointerState()
  private readonly foregroundDeferredMailboxes = new Map<
    string,
    Map<string, ReadonlySet<string> | undefined>
  >()
  private readonly coldParkedPtys = new Set<string>()
  constructor(private readonly deps: PointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    try {
      const terminal = this.deps.deliveryTarget.resolveTerminal(handle)
      this.deps.wakeSleepingRecipient?.(handle, reservedTypes)
      // Skip ownership resolution, and the reconciliation it schedules, for a terminal deliver() would refuse.
      if (!terminal || !isMailboxTerminalTakingInput(terminal)) {
        return
      }
      const mailboxHandle = this.deps.mailboxOwner.resolve(terminal, handle)
      if (mailboxHandle) {
        this.deliver(terminal, { mailboxHandle, reservedTypes })
      }
    } catch {
      // Persisted mail remains available to explicit check or the terminal's next input edge.
    }
  }

  deliver(
    terminal: OrchestrationMailboxTerminal,
    options: {
      mailboxHandle: string
      reservedTypes?: ReadonlySet<string>
      skipAbsenceProbe?: boolean
      foregroundProbeIncarnation?: string
    }
  ): void {
    const db = this.deps.getDb()
    const mailboxHandle = options.mailboxHandle
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
    if (this.isForegroundHeld(ptyId)) {
      return
    }
    // Gate live, settled input at this shared commit point; refusal parks for recheck instead of dropping mail.
    if (!isMailboxTerminalTakingInput(terminal) || !this.deps.isAgentSettledForDelivery(ptyId)) {
      this.parkRedelivery(mailboxHandle, options.reservedTypes)
      return
    }
    // As in observeAgentWorking: a cold-parked terminal's deferred Enter waits for rest.
    const deferredEnter =
      this.coldParkedPtys.has(ptyId) && terminal.lastAgentStatus !== 'idle'
        ? null
        : this.state.takeDeferredEnter(ptyId)
    if (deferredEnter) {
      this.state.parkDelivery(ptyId, mailboxHandle, options.reservedTypes)
      deferredEnter()
      return
    }
    if (this.state.hasFlight(ptyId)) {
      this.state.parkDelivery(ptyId, mailboxHandle, options.reservedTypes)
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
    const pending = db.getPendingMailboxPointerMessages(mailboxHandle)
    if (
      pending.length > 0 &&
      resumePendingOrchestrationMailboxPointer({ deps: this.deps, terminal, messages: pending })
    ) {
      return
    }
    const { messages: unread, heldDeliveryId } = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters,
      reservedTypes: options.reservedTypes,
      excludeRunOwnedDirect: isOwnDirectMailbox
    })
    if (unread.length === 0) {
      return
    }
    const newestSequence = unread.at(-1)?.sequence
    if (newestSequence === undefined) {
      return
    }
    if (!this.state.releaseSupersededWatermark(mailboxHandle, newestSequence, ptyId)) {
      return
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
    const target = this.deps.resolveSubmitTarget(ptyId)
    if (!target) {
      return
    }
    if (options.foregroundProbeIncarnation !== target.processIncarnation) {
      const deferred = this.foregroundDeferredMailboxes.get(ptyId)
      if (deferred) {
        deferred.set(mailboxHandle, options.reservedTypes)
        return
      }
      const mailboxes = new Map([[mailboxHandle, options.reservedTypes]])
      this.foregroundDeferredMailboxes.set(ptyId, mailboxes)
      void this.probeForeground(ptyId, target.processIncarnation)
        .then((foreground) => {
          this.foregroundDeferredMailboxes.delete(ptyId)
          const current = this.deps.resolveSubmitTarget(ptyId)
          const retryProbe =
            current?.processIncarnation === target.processIncarnation &&
            foreground.foreground === 'shell' &&
            !this.holdForeground(ptyId, foreground)
          for (const [probedMailbox, reservedTypes] of mailboxes) {
            const terminal = this.deps.getTerminal(ptyId)
            if (terminal) {
              this.deliver(terminal, {
                mailboxHandle: probedMailbox,
                reservedTypes,
                skipAbsenceProbe: true,
                foregroundProbeIncarnation: retryProbe ? undefined : target.processIncarnation
              })
            }
          }
        })
        .catch(() => undefined)
      return
    }
    // Every path stages here, async retries included: type only for a mailbox this terminal still owns.
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
      mailboxHandle,
      messages: unread,
      heldDeliveryId,
      newestSequence,
      enterDelayMs: pointerEnterDelayMs(),
      settle: (ptyId, flight) => this.settle(ptyId, flight),
      redrive: (redriveMailbox, force) => this.redrive(redriveMailbox, force)
    })
  }

  readonly probeForeground = (ptyId: string, processIncarnation: string) =>
    this.state.probeForeground(ptyId, processIncarnation, () => this.deps.readForeground(ptyId))

  readonly holdForeground = this.state.holdForeground.bind(this.state)

  captureForegroundObservation(ptyId: string) {
    const processIncarnation = this.deps.resolveSubmitTarget(ptyId)?.processIncarnation
    return processIncarnation
      ? this.state.captureForegroundObservation(ptyId, processIncarnation)
      : undefined
  }

  isForegroundHeld(ptyId: string): boolean {
    const hold = this.state.foregroundHold(ptyId)
    if (hold && hold !== this.deps.resolveSubmitTarget(ptyId)?.processIncarnation) {
      this.observeTerminal(ptyId)
      return false
    }
    return !!hold
  }

  observeTerminal(ptyId: string): void {
    if (this.state.observeTerminal(ptyId)) {
      queueMicrotask(() => this.deps.redriveTerminal(ptyId))
    }
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    this.state.parkRedelivery(mailboxHandle, reservedTypes)
  }

  retirePty(ptyId: string): void {
    this.observeTerminal(ptyId)
    this.coldParkedPtys.delete(ptyId)
    const { flight, releasedMailboxes } = this.state.retirePty(ptyId)
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

  private redeliverAfterProbe(ptyId: string, mailboxHandle: string): void {
    const current = this.deps.getTerminal(ptyId)
    if (current) {
      this.deliver(current, { mailboxHandle, skipAbsenceProbe: true })
    }
  }

  private settle(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): void {
    const parked = this.state.settleFlight(ptyId, flight)
    if (!parked) {
      return
    }
    const current = this.deps.getTerminal(ptyId)
    for (const [mailboxHandle, reservedTypes] of parked) {
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
