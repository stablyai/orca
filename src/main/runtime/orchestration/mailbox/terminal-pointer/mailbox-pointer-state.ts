export type OrchestrationMailboxDeliveryFlight = {
  enterTimer: ReturnType<typeof setTimeout> | null
  stagedMessageIds: string[]
  submitEnter: (() => void) | null
  deferredUntilIdle: boolean
  idleObservedWhileDeferred: boolean
  /** The incarnation that staged this flight, so retirement can name the rows it owns. */
  processIncarnation?: string
}

/** A submitted pointer whose mail the agent has not checked yet. `queued`: typed mid-turn, so it
 *  waits behind that turn; `submitted`: Enter landed at rest, its turn not seen yet; `started`. */
type PointerAnnouncement = {
  ptyId: string
  messageIds: readonly string[]
  phase: 'queued' | 'submitted' | 'started'
  startTimer: ReturnType<typeof setTimeout> | null
  onNeverStarted: () => void
}

/** Bounds a hold whose Enter may have been lost: no turn by then means nothing will read the mail. */
const ANNOUNCED_TURN_START_GRACE_MS = 10_000

/** A mailbox waiting behind a terminal's in-flight pointer, with the types its waiters reserve. */
type ParkedOrchestrationMailboxDeliveries = Map<string, ReadonlySet<string> | undefined>

export class OrchestrationMailboxPointerState {
  private readonly flightsByPtyId = new Map<string, OrchestrationMailboxDeliveryFlight>()
  private readonly parkedDeliveriesByPtyId = new Map<string, ParkedOrchestrationMailboxDeliveries>()
  private readonly watermarkByMailbox = new Map<
    string,
    { ptyId: string; sequence: number; active: boolean }
  >()
  private readonly watermarkMailboxesByPtyId = new Map<string, Set<string>>()
  private readonly parkedTypesByMailbox = new Map<string, ReadonlySet<string> | null>()
  private readonly announcementByMailbox = new Map<string, PointerAnnouncement>()

  /** Record a pointer at its Enter, so newer mail waits for the check that pointer starts (#41854). */
  announce(
    mailboxHandle: string,
    ptyId: string,
    messageIds: readonly string[],
    midTurn: boolean,
    onNeverStarted: () => void
  ): void {
    this.forgetAnnouncement(mailboxHandle)
    const announcement: PointerAnnouncement = {
      ptyId,
      messageIds,
      phase: midTurn ? 'queued' : 'submitted',
      startTimer: null,
      onNeverStarted
    }
    this.announcementByMailbox.set(mailboxHandle, announcement)
    if (!midTurn) {
      this.armAnnouncementStart(mailboxHandle, announcement)
    }
  }

  /** The announced message ids still holding this mailbox's next pointer on this PTY, if any. */
  announcedMessageIds(mailboxHandle: string, ptyId: string): readonly string[] | null {
    const announcement = this.announcementByMailbox.get(mailboxHandle)
    return announcement?.ptyId === ptyId ? announcement.messageIds : null
  }

  forgetAnnouncement(mailboxHandle: string, ptyId?: string): void {
    const announcement = this.announcementByMailbox.get(mailboxHandle)
    if (!announcement || (ptyId !== undefined && announcement.ptyId !== ptyId)) {
      return
    }
    if (announcement.startTimer != null) {
      clearTimeout(announcement.startTimer)
    }
    this.announcementByMailbox.delete(mailboxHandle)
  }

  /** An exited PTY's announcements must not hold mail for a later process reusing its id. */
  forgetPtyAnnouncements(ptyId: string): void {
    for (const [mailboxHandle, announcement] of this.announcementByMailbox) {
      if (announcement.ptyId === ptyId) {
        this.forgetAnnouncement(mailboxHandle)
      }
    }
  }

  observeAnnouncedWorking(ptyId: string): void {
    for (const announcement of this.announcementByMailbox.values()) {
      if (announcement.ptyId === ptyId && announcement.phase === 'submitted') {
        announcement.phase = 'started'
        if (announcement.startTimer != null) {
          clearTimeout(announcement.startTimer)
          announcement.startTimer = null
        }
      }
    }
  }

  /** A started turn that ended without a check frees the mailbox; a queued pointer submits now. */
  observeAnnouncedIdle(ptyId: string): void {
    for (const [mailboxHandle, announcement] of this.announcementByMailbox) {
      if (announcement.ptyId !== ptyId) {
        continue
      }
      if (announcement.phase === 'started') {
        this.announcementByMailbox.delete(mailboxHandle)
      } else if (announcement.phase === 'queued') {
        announcement.phase = 'submitted'
        this.armAnnouncementStart(mailboxHandle, announcement)
      }
    }
  }

  private armAnnouncementStart(mailboxHandle: string, announcement: PointerAnnouncement): void {
    announcement.startTimer = setTimeout(() => {
      announcement.startTimer = null
      if (this.announcementByMailbox.get(mailboxHandle) === announcement) {
        this.announcementByMailbox.delete(mailboxHandle)
        announcement.onNeverStarted()
      }
    }, ANNOUNCED_TURN_START_GRACE_MS)
    announcement.startTimer.unref?.()
  }

  hasFlight(ptyId: string): boolean {
    return this.flightsByPtyId.has(ptyId)
  }

  isDeferred(ptyId: string): boolean {
    return this.flightsByPtyId.get(ptyId)?.deferredUntilIdle === true
  }

  beginFlight(ptyId: string): OrchestrationMailboxDeliveryFlight {
    const flight = {
      enterTimer: null,
      stagedMessageIds: [],
      submitEnter: null,
      deferredUntilIdle: false,
      idleObservedWhileDeferred: false
    }
    this.flightsByPtyId.set(ptyId, flight)
    return flight
  }

  isCurrentFlight(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): boolean {
    return this.flightsByPtyId.get(ptyId) === flight
  }

  deferFlightUntilIdle(ptyId: string): boolean {
    const flight = this.flightsByPtyId.get(ptyId)
    if (!flight) {
      return false
    }
    if (flight.enterTimer != null) {
      clearTimeout(flight.enterTimer)
      flight.enterTimer = null
    }
    flight.deferredUntilIdle = true
    flight.idleObservedWhileDeferred = false
    return true
  }

  takeDeferredEnter(ptyId: string): (() => void) | null {
    const flight = this.flightsByPtyId.get(ptyId)
    if (!flight?.deferredUntilIdle) {
      return null
    }
    if (!flight.submitEnter) {
      flight.idleObservedWhileDeferred = true
      return null
    }
    const submitEnter = flight.submitEnter
    flight.submitEnter = null
    flight.deferredUntilIdle = false
    flight.idleObservedWhileDeferred = false
    return submitEnter
  }

  settleFlight(
    ptyId: string,
    flight: OrchestrationMailboxDeliveryFlight
  ): ParkedOrchestrationMailboxDeliveries | null {
    if (!this.isCurrentFlight(ptyId, flight)) {
      return null
    }
    this.flightsByPtyId.delete(ptyId)
    const parked = this.parkedDeliveriesByPtyId.get(ptyId) ?? null
    this.parkedDeliveriesByPtyId.delete(ptyId)
    return parked
  }

  parkDelivery(ptyId: string, mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    const parked: ParkedOrchestrationMailboxDeliveries =
      this.parkedDeliveriesByPtyId.get(ptyId) ?? new Map()
    const prior = parked.get(mailboxHandle)
    const current = reservedTypes && reservedTypes.size > 0 ? reservedTypes : undefined
    let merged: Set<string> | undefined
    if (!parked.has(mailboxHandle)) {
      merged = current ? new Set(current) : undefined
    } else if (prior && current) {
      merged = new Set([...prior, ...current])
    }
    parked.set(mailboxHandle, merged)
    this.parkedDeliveriesByPtyId.set(ptyId, parked)
  }

  hasActiveWatermark(mailboxHandle: string): boolean {
    return this.watermarkByMailbox.get(mailboxHandle)?.active === true
  }

  releaseSupersededWatermark(
    mailboxHandle: string,
    newestSequence: number,
    ptyId: string
  ): boolean {
    const owner = this.watermarkByMailbox.get(mailboxHandle)
    if (newestSequence > (owner?.sequence ?? -1)) {
      return true
    }
    return Boolean(
      owner &&
      !owner.active &&
      owner.ptyId !== ptyId &&
      this.clearWatermark(mailboxHandle, owner.sequence, owner.ptyId)
    )
  }

  setWatermark(mailbox: string, sequence: number, ptyId: string): void {
    const prior = this.watermarkByMailbox.get(mailbox)
    if (prior && prior.ptyId !== ptyId) {
      this.removeWatermarkPtyIndex(mailbox, prior.ptyId)
    }
    this.watermarkByMailbox.set(mailbox, { ptyId, sequence, active: true })
    const mailboxes = this.watermarkMailboxesByPtyId.get(ptyId) ?? new Set<string>()
    mailboxes.add(mailbox)
    this.watermarkMailboxesByPtyId.set(ptyId, mailboxes)
  }

  clearWatermark(mailbox: string, sequence: number, ptyId: string): boolean {
    const owner = this.watermarkByMailbox.get(mailbox)
    if (!owner || owner.ptyId !== ptyId || owner.sequence !== sequence) {
      return false
    }
    this.watermarkByMailbox.delete(mailbox)
    this.removeWatermarkPtyIndex(mailbox, ptyId)
    return true
  }

  deactivateWatermark(mailbox: string, sequence: number, ptyId: string): boolean {
    const owner = this.watermarkByMailbox.get(mailbox)
    if (!owner || owner.ptyId !== ptyId || owner.sequence !== sequence) {
      return false
    }
    owner.active = false
    return true
  }

  parkRedelivery(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): void {
    const prior = this.parkedTypesByMailbox.get(mailboxHandle)
    const hasPrior = this.parkedTypesByMailbox.has(mailboxHandle)
    const current = reservedTypes && reservedTypes.size > 0 ? reservedTypes : undefined
    if (!hasPrior) {
      this.parkedTypesByMailbox.set(mailboxHandle, current ? new Set(current) : null)
      return
    }
    if (prior == null || current === undefined) {
      this.parkedTypesByMailbox.set(mailboxHandle, null)
      return
    }
    this.parkedTypesByMailbox.set(mailboxHandle, new Set([...prior, ...current]))
  }

  takeRedelivery(mailboxHandle: string, force: boolean): ReadonlySet<string> | null | undefined {
    const parkedTypes = this.parkedTypesByMailbox.get(mailboxHandle)
    if (!force && parkedTypes === undefined) {
      return undefined
    }
    this.parkedTypesByMailbox.delete(mailboxHandle)
    return parkedTypes ?? null
  }

  retirePty(ptyId: string): {
    flight: OrchestrationMailboxDeliveryFlight | undefined
    releasedMailboxes: string[]
  } {
    const flight = this.flightsByPtyId.get(ptyId)
    this.flightsByPtyId.delete(ptyId)
    this.parkedDeliveriesByPtyId.delete(ptyId)
    const releasedMailboxes: string[] = []
    for (const mailboxHandle of this.watermarkMailboxesByPtyId.get(ptyId) ?? []) {
      const owner = this.watermarkByMailbox.get(mailboxHandle)
      if (owner?.ptyId === ptyId && this.clearWatermark(mailboxHandle, owner.sequence, ptyId)) {
        releasedMailboxes.push(mailboxHandle)
      }
    }
    this.watermarkMailboxesByPtyId.delete(ptyId)
    return { flight, releasedMailboxes }
  }

  private removeWatermarkPtyIndex(mailbox: string, ptyId: string): void {
    const mailboxes = this.watermarkMailboxesByPtyId.get(ptyId)
    mailboxes?.delete(mailbox)
    if (mailboxes?.size === 0) {
      this.watermarkMailboxesByPtyId.delete(ptyId)
    }
  }
}
