import type {
  AssignmentAdmissionRejection,
  RelayPublicAssignmentAdmission
} from './public-assignment-admission.js'

export type DrainReturnGrant = { kind: 'admitted'; lease: { release(): void } }
export type DrainReturnDeferral = {
  kind: 'deferred'
  reason: AssignmentAdmissionRejection
  retryAfterSeconds: number
}

// Why the minimum: the sticky lane's answer, and the lane's own per-host
// interval, so an honoured Retry-After is never refused as a too-fast retry.
export const DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS = 2
// Measured c29 2026-10-01: ~5.8 re-placements/s across 5 directors, i.e. ~860 ms
// of serialized store time per re-placement on one director.
const DRAIN_RETURN_INITIAL_SERVICE_MS = 860
const SERVICE_MS_FLOOR = 20
const SERVICE_MS_CEILING = 15_000
const SERVICE_EWMA_WEIGHT = 0.2
const MAX_RESERVATIONS = 4_096

type DrainReturnLane = Pick<
  RelayPublicAssignmentAdmission,
  'acquireDrainReturn' | 'queuedDrainReturns'
>

// Hosts whose home cell is isolated for a roll get their own admission budget,
// so a drain's cohort never waits in (or starves) the sticky or placement queues.
// When the lane is full the host is told when to come back: each deferral takes
// the next free service slot after the work already promised, so a cohort larger
// than the lane can serve returns at the rate the lane drains rather than on
// every client's own 2 s retry.
export class RelayDrainReturnAdmission {
  private serviceMs = DRAIN_RETURN_INITIAL_SERVICE_MS
  private nextReturnAt = 0
  // A host that comes back early keeps its slot rather than booking another.
  private readonly reservations = new Map<string, number>()

  constructor(
    private readonly lane: DrainReturnLane,
    private readonly options: {
      maxConcurrent: number
      maxRetryAfterSeconds: number
      now?: () => number
      // The raw sample behind the EWMA, so the lane's service time is reported.
      onServiceMs?: (durationMs: number) => void
    }
  ) {}

  async acquire(relayHostId: string): Promise<DrainReturnGrant | DrainReturnDeferral> {
    let reason: AssignmentAdmissionRejection = 'queue-full'
    const lease = await this.lane.acquireDrainReturn(relayHostId, (rejection) => {
      reason = rejection
    })
    if (!lease)
      return { kind: 'deferred', reason, retryAfterSeconds: this.retryAfter(relayHostId, reason) }
    this.reservations.delete(relayHostId)
    const startedAt = this.now()
    let released = false
    return {
      kind: 'admitted',
      lease: {
        release: () => {
          if (released) return
          released = true
          this.recordService(this.now() - startedAt)
          lease.release()
        }
      }
    }
  }

  private retryAfter(relayHostId: string, reason: AssignmentAdmissionRejection): number {
    // The host's own retry (a row-busy redial, a duplicate dial) is not a lane
    // overflow: it gets the per-host interval, not a place behind the cohort.
    if (reason === 'host-rate-limited' || reason === 'host-in-flight') {
      return DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS
    }
    const now = this.now()
    const reserved = this.reservations.get(relayHostId)
    const returnAt =
      reserved !== undefined && reserved > now ? reserved : this.reserveReturn(relayHostId, now)
    return Math.min(
      this.options.maxRetryAfterSeconds,
      Math.max(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS, Math.ceil((returnAt - now) / 1_000))
    )
  }

  private reserveReturn(relayHostId: string, now: number): number {
    const slotMs = this.serviceMs / this.options.maxConcurrent
    // Hosts already queued here are served first; a deferral starts after them.
    const earliest =
      now +
      Math.max(
        DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS * 1_000,
        (this.lane.queuedDrainReturns + 1) * slotMs
      )
    this.nextReturnAt = Math.min(
      Math.max(this.nextReturnAt + slotMs, earliest),
      now + this.options.maxRetryAfterSeconds * 1_000
    )
    this.reservations.delete(relayHostId)
    this.reservations.set(relayHostId, this.nextReturnAt)
    if (this.reservations.size > MAX_RESERVATIONS) {
      this.reservations.delete(this.reservations.keys().next().value!)
    }
    return this.nextReturnAt
  }

  private recordService(durationMs: number): void {
    this.options.onServiceMs?.(durationMs)
    const sample = Math.min(SERVICE_MS_CEILING, Math.max(SERVICE_MS_FLOOR, durationMs))
    this.serviceMs += SERVICE_EWMA_WEIGHT * (sample - this.serviceMs)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}
