import type { OrchestrationMailboxLeaf } from './mailbox-owner'

export type OrchestrationMailboxDeliveryFlight = {
  enterTimer: ReturnType<typeof setTimeout> | null
  stagedMessageIds: string[]
}

export type ParkedOrchestrationMailboxDelivery = {
  leaf: OrchestrationMailboxLeaf
  reservedTypes?: ReadonlySet<string>
}

export class OrchestrationMailboxPointerState {
  private readonly flightsByPtyId = new Map<string, OrchestrationMailboxDeliveryFlight>()
  private readonly parkedDeliveriesByPtyId = new Map<
    string,
    Map<string, ParkedOrchestrationMailboxDelivery>
  >()
  private readonly watermarkByMailbox = new Map<
    string,
    { ptyId: string; sequence: number; leafKey: string; active: boolean }
  >()
  private readonly watermarkMailboxesByPtyId = new Map<string, Set<string>>()
  private readonly parkedTypesByMailbox = new Map<string, ReadonlySet<string> | null>()

  hasFlight(ptyId: string): boolean {
    return this.flightsByPtyId.has(ptyId)
  }

  beginFlight(ptyId: string): OrchestrationMailboxDeliveryFlight {
    const flight = { enterTimer: null, stagedMessageIds: [] }
    this.flightsByPtyId.set(ptyId, flight)
    return flight
  }

  isCurrentFlight(ptyId: string, flight: OrchestrationMailboxDeliveryFlight): boolean {
    return this.flightsByPtyId.get(ptyId) === flight
  }

  settleFlight(
    ptyId: string,
    flight: OrchestrationMailboxDeliveryFlight
  ): Map<string, ParkedOrchestrationMailboxDelivery> | null {
    if (!this.isCurrentFlight(ptyId, flight)) {
      return null
    }
    this.flightsByPtyId.delete(ptyId)
    const parked = this.parkedDeliveriesByPtyId.get(ptyId) ?? null
    this.parkedDeliveriesByPtyId.delete(ptyId)
    return parked
  }

  parkDelivery(
    ptyId: string,
    mailboxHandle: string,
    leaf: OrchestrationMailboxLeaf,
    reservedTypes?: ReadonlySet<string>
  ): void {
    const parked = this.parkedDeliveriesByPtyId.get(ptyId) ?? new Map()
    const priorEntry = parked.get(mailboxHandle)
    const prior = priorEntry?.reservedTypes
    const current = reservedTypes && reservedTypes.size > 0 ? reservedTypes : undefined
    let merged: Set<string> | undefined
    if (!priorEntry) {
      merged = current ? new Set(current) : undefined
    } else if (prior && current) {
      merged = new Set([...prior, ...current])
    }
    parked.set(mailboxHandle, { leaf, reservedTypes: merged })
    this.parkedDeliveriesByPtyId.set(ptyId, parked)
  }

  hasActiveWatermark(mailboxHandle: string): boolean {
    return this.watermarkByMailbox.get(mailboxHandle)?.active === true
  }

  releaseSupersededWatermark(
    mailboxHandle: string,
    newestSequence: number,
    ptyId: string | null,
    leafKey: string
  ): boolean {
    const owner = this.watermarkByMailbox.get(mailboxHandle)
    if (newestSequence > (owner?.sequence ?? -1)) {
      return true
    }
    return Boolean(
      owner &&
      !owner.active &&
      !(owner.ptyId === ptyId && owner.leafKey === leafKey) &&
      this.clearWatermark(mailboxHandle, owner.sequence, owner.ptyId)
    )
  }

  setWatermark(mailbox: string, sequence: number, ptyId: string, leafKey: string): void {
    const prior = this.watermarkByMailbox.get(mailbox)
    if (prior && prior.ptyId !== ptyId) {
      this.removeWatermarkPtyIndex(mailbox, prior.ptyId)
    }
    this.watermarkByMailbox.set(mailbox, { ptyId, sequence, leafKey, active: true })
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
