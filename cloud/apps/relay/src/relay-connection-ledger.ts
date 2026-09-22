import type WebSocket from 'ws'

export type RelayConnectionLedgerCounts = {
  physicalConnections: number
  inFlightConnections: number
  reservedConnectionUnits: number
  enforcedConnectionUnits: number
}

export type RelayConnectionLedgerSnapshot = RelayConnectionLedgerCounts & {
  inclusionWatermark: number
}

export type PendingHostDataReservation = {
  bind: (connectionId: string) => void
  release: () => void
}

type ReservationState = 'reserved' | 'claimed' | 'consumed' | 'released'
type UpgradeState = 'in-flight' | 'physical' | 'released'

class HostDataReservation implements PendingHostDataReservation {
  private state: ReservationState = 'reserved'
  private connectionId: string | null = null

  constructor(private readonly ledger: RelayConnectionLedger) {}

  bind(connectionId: string): void {
    if (this.state !== 'reserved' || this.connectionId !== null) {
      throw new Error('host_data_reservation_already_bound')
    }
    this.connectionId = connectionId
    this.ledger.bindHostData(connectionId, this)
  }

  release(): void {
    if (this.state === 'reserved') {
      this.ledger.releaseReserved(this)
    }
    if (this.state !== 'consumed') {
      this.state = 'released'
    }
  }

  claim(): void {
    if (this.state !== 'reserved') throw new Error('host_data_reservation_unavailable')
    this.state = 'claimed'
  }

  consume(): boolean {
    if (this.state !== 'claimed') return false
    this.state = 'consumed'
    return true
  }

  restore(): void {
    if (this.state !== 'claimed') return
    this.state = this.ledger.restoreReserved(this) ? 'reserved' : 'released'
  }

  matches(connectionId: string): boolean {
    return this.connectionId === connectionId
  }

  get boundConnectionId(): string | null {
    return this.connectionId
  }
}

export class RelayConnectionUpgrade {
  private state: UpgradeState = 'in-flight'

  constructor(
    private readonly ledger: RelayConnectionLedger,
    readonly inclusionWatermark: number,
    private readonly hostDataReservation: HostDataReservation | null = null
  ) {}

  promote(socket: WebSocket): void {
    if (this.state !== 'in-flight') throw new Error('connection_upgrade_not_in_flight')
    this.state = 'physical'
    this.ledger.promoteUpgrade()
    socket.once('close', () => this.release())
  }

  commitHostData(): boolean {
    return this.hostDataReservation?.consume() ?? false
  }

  release(): void {
    if (this.state === 'released') return
    if (this.state === 'in-flight') this.ledger.releaseUpgrade()
    else this.ledger.releasePhysical()
    this.state = 'released'
    this.hostDataReservation?.restore()
  }
}

export type PhoneConnectionAdmission = {
  upgrade: RelayConnectionUpgrade
  hostData: PendingHostDataReservation
}

export class RelayConnectionLedger {
  private physicalConnections = 0
  private inFlightConnections = 0
  private reservedConnectionUnits = 0
  private inclusionWatermark = 0
  private readonly hostDataByConnectionId = new Map<string, HostDataReservation>()

  constructor(
    private readonly hardCap: number,
    private readonly controlReserve: number
  ) {
    if (hardCap <= 0 || controlReserve < 0 || controlReserve >= hardCap) {
      throw new Error('invalid_connection_ledger_capacity')
    }
  }

  tryReserveControl(rebind: boolean): RelayConnectionUpgrade | null {
    return this.reserveUpgrade(rebind ? this.hardCap : this.normalAdmissionLimit)
  }

  tryReservePhone(): PhoneConnectionAdmission | null {
    if (this.enforcedConnectionUnits + 2 > this.normalAdmissionLimit) return null
    const reservation = new HostDataReservation(this)
    const inclusionWatermark = this.advanceWatermark()
    this.inFlightConnections++
    this.reservedConnectionUnits++
    return {
      upgrade: new RelayConnectionUpgrade(this, inclusionWatermark),
      hostData: reservation
    }
  }

  tryReserveHostData(connectionId: string): RelayConnectionUpgrade | null {
    const reservation = this.hostDataByConnectionId.get(connectionId)
    if (reservation?.matches(connectionId)) {
      this.hostDataByConnectionId.delete(connectionId)
      reservation.claim()
      const inclusionWatermark = this.advanceWatermark()
      this.reservedConnectionUnits--
      this.inFlightConnections++
      return new RelayConnectionUpgrade(this, inclusionWatermark, reservation)
    }
    return this.reserveUpgrade(this.normalAdmissionLimit)
  }

  counts(): RelayConnectionLedgerCounts {
    return {
      physicalConnections: this.physicalConnections,
      inFlightConnections: this.inFlightConnections,
      reservedConnectionUnits: this.reservedConnectionUnits,
      enforcedConnectionUnits: this.enforcedConnectionUnits
    }
  }

  snapshot(): RelayConnectionLedgerSnapshot {
    return {
      ...this.counts(),
      inclusionWatermark: this.advanceWatermark()
    }
  }

  bindHostData(connectionId: string, reservation: HostDataReservation): void {
    if (this.hostDataByConnectionId.has(connectionId)) {
      throw new Error('host_data_reservation_conflict')
    }
    this.hostDataByConnectionId.set(connectionId, reservation)
  }

  releaseReserved(reservation: HostDataReservation): void {
    const connectionId = reservation.boundConnectionId
    if (connectionId && this.hostDataByConnectionId.get(connectionId) === reservation) {
      this.hostDataByConnectionId.delete(connectionId)
    }
    this.advanceWatermark()
    this.reservedConnectionUnits--
  }

  restoreReserved(reservation: HostDataReservation): boolean {
    const connectionId = reservation.boundConnectionId
    if (!connectionId || this.hostDataByConnectionId.has(connectionId)) {
      return false
    }
    this.advanceWatermark()
    this.reservedConnectionUnits++
    this.hostDataByConnectionId.set(connectionId, reservation)
    return true
  }

  promoteUpgrade(): void {
    this.advanceWatermark()
    this.inFlightConnections--
    this.physicalConnections++
  }

  releaseUpgrade(): void {
    this.advanceWatermark()
    this.inFlightConnections--
  }

  releasePhysical(): void {
    this.advanceWatermark()
    this.physicalConnections--
  }

  private reserveUpgrade(limit: number): RelayConnectionUpgrade | null {
    if (this.enforcedConnectionUnits + 1 > limit) return null
    const inclusionWatermark = this.advanceWatermark()
    this.inFlightConnections++
    return new RelayConnectionUpgrade(this, inclusionWatermark)
  }

  private advanceWatermark(): number {
    this.inclusionWatermark++
    return this.inclusionWatermark
  }

  private get normalAdmissionLimit(): number {
    return this.hardCap - this.controlReserve
  }

  private get enforcedConnectionUnits(): number {
    return (
      this.physicalConnections + this.inFlightConnections + this.reservedConnectionUnits
    )
  }
}
