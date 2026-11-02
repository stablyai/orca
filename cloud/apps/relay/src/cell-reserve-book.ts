import {
  CELL_INTAKE_BURST,
  type ReserveItem,
  type ReserveOutcome
} from './cell-reserve-contract.js'

// The cell's half of step 5: it alone says yes or no to each booking. One event loop makes
// "check cap and budget, then count the booking" atomic with no lock.

// A connection unit held for a booked host until its hello consumes it or the TTL ends.
export type BookingUnit = { release(): void }

export type BookingCapacity = {
  // Null when one more unit would cross the cell's placement ceiling.
  tryReserve(): BookingUnit | null
  canReserve(): boolean
}

export type CellAdmitMode = 'db' | 'reserve'

export type ReserveContext = {
  mode: CellAdmitMode
  draining: boolean
  // The epoch this host is seated at here, if it is.
  seatedEpoch: (userId: string, relayHostId: string) => number | undefined
}

export type CellBooking = {
  userId: string
  relayHostId: string
  epoch: number
  directorId: string
  expiresAt: number
}

// `handedOff`: the host's upgrade now counts this unit, so the booking holds none.
type HeldBooking = CellBooking & { unit: BookingUnit; handedOff: boolean }

function hostKey(userId: string, relayHostId: string): string {
  return `${userId}\u0000${relayHostId}`
}

export class IntakeBucket {
  private tokens: number
  private refilledAt: number

  constructor(
    private readonly ratePerSec: () => number,
    private readonly burst: number,
    now: number
  ) {
    this.tokens = burst
    this.refilledAt = now
  }

  available(now: number): number {
    const elapsedMs = Math.max(0, now - this.refilledAt)
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1_000) * this.ratePerSec())
    this.refilledAt = now
    return this.tokens
  }

  take(now: number): boolean {
    if (this.available(now) < 1) return false
    this.tokens -= 1
    return true
  }
}

export class CellReserveBook {
  private readonly bookings = new Map<string, HeldBooking>()
  private readonly intake: IntakeBucket

  constructor(
    private readonly capacity: BookingCapacity,
    private readonly intakePerSec: () => number,
    private readonly now: () => number = Date.now,
    private readonly burst = CELL_INTAKE_BURST
  ) {
    this.intake = new IntakeBucket(intakePerSec, burst, now())
  }

  reserve(
    directorId: string,
    item: ReserveItem,
    context: ReserveContext,
    dryRun = false
  ): ReserveOutcome {
    const now = this.now()
    this.sweep(now)
    if (context.mode !== 'reserve' && !dryRun) return { outcome: 'off' }
    if (context.draining) return { outcome: 'draining' }
    const key = hostKey(item.userId, item.relayHostId)
    const seated = context.seatedEpoch(item.userId, item.relayHostId)
    const booked = this.bookings.get(key)
    const known = Math.max(seated ?? 0, booked?.epoch ?? 0)
    if (item.sticky) {
      if (known > item.epoch) return { outcome: 'seated-newer', epoch: known }
      if (seated === item.epoch) return { outcome: 'ok' }
      if (booked?.epoch === item.epoch) {
        if (!dryRun) booked.expiresAt = Math.max(booked.expiresAt, now + item.ttlMs)
        return { outcome: 'ok' }
      }
    } else if (known >= item.epoch) {
      return { outcome: 'seated-newer', epoch: known }
    }
    // A lower-epoch booking for this host hands its unit to the new one.
    const heldUnit = booked && !booked.handedOff ? booked.unit : undefined
    if (!heldUnit && !this.capacity.canReserve()) return { outcome: 'full' }
    // The post-restart sticky re-booking books nothing new, so it takes no token.
    if (!item.sticky && this.intake.available(now) < 1) return { outcome: 'intake' }
    if (dryRun) return { outcome: 'ok' }
    const unit = heldUnit ?? this.capacity.tryReserve()
    if (!unit) return { outcome: 'full' }
    if (!item.sticky) this.intake.take(now)
    this.bookings.set(key, {
      userId: item.userId,
      relayHostId: item.relayHostId,
      epoch: item.epoch,
      directorId,
      expiresAt: now + item.ttlMs,
      unit,
      handedOff: false
    })
    return { outcome: 'ok' }
  }

  has(userId: string, relayHostId: string): boolean {
    const booking = this.bookings.get(hostKey(userId, relayHostId))
    return booking !== undefined && booking.expiresAt > this.now()
  }

  // The booked host's upgrade takes over its unit, so the host counts once until its hello.
  // The upgrade carries no epoch; the hello's take() still requires the booked one.
  handOff(userId: string, relayHostId: string): void {
    const booking = this.bookings.get(hostKey(userId, relayHostId))
    if (!booking || booking.handedOff || booking.expiresAt <= this.now()) return
    booking.handedOff = true
    booking.unit.release()
  }

  // The hello's rule 1: a booking for this host at exactly this epoch admits it once.
  take(userId: string, relayHostId: string, epoch: number): CellBooking | null {
    const key = hostKey(userId, relayHostId)
    const booking = this.bookings.get(key)
    if (!booking || booking.epoch !== epoch || booking.expiresAt <= this.now()) return null
    this.bookings.delete(key)
    booking.unit.release()
    const { unit: _unit, ...held } = booking
    return held
  }

  // Leaving reserve mode, or the cell starting to drain, voids every booking.
  clear(): void {
    for (const booking of this.bookings.values()) booking.unit.release()
    this.bookings.clear()
  }

  sweep(now = this.now()): void {
    for (const [key, booking] of this.bookings) {
      if (booking.expiresAt > now) continue
      this.bookings.delete(key)
      booking.unit.release()
    }
  }

  count(): number {
    return this.bookings.size
  }

  intakeSnapshot(): { perSec: number; burst: number; tokens: number } {
    return {
      perSec: this.intakePerSec(),
      burst: this.burst,
      tokens: Math.floor(this.intake.available(this.now()) * 100) / 100
    }
  }
}
