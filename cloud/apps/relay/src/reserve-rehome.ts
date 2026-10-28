import { RELAY_CLOSE_CODE, type RelayRegion } from '@orca-cloud/relay-contract'
import { hostCohortBucket } from './host-cohort-bucket.js'

// Rehome only on an existing reconnect outside the requested region; failed rules retain sticky answer, never force disconnect/503.

// Require 10% target headroom above the 0% spill line so spilled hosts return only with real room.
export const RESERVE_REHOME_TARGET_FREE_SHARE = 0.1
// Two installs sharing one identity replace each other with PEER_DROPPED.
export const RESERVE_REHOME_PEER_DROPPED_MS = 10 * 60_000
export const RESERVE_REHOME_HOST_COOLDOWN_MS = 24 * 60 * 60_000
const RESERVE_REHOME_MOVED_MAX = 100_000
// Per director: 5 directors move at most 1.25% of a cell in 5 minutes, under the watcher's 5%.
export const RESERVE_REHOME_SOURCE_SHARE_PER_MINUTE = 0.0005
// The kill switch is re-read this often; an answer older than the stale bound reads as off.
export const RESERVE_REHOME_SWITCH_POLL_MS = 30_000
export const RESERVE_REHOME_SWITCH_STALE_MS = 2 * 60_000

export type RehomeSkip =
  | 'switch'
  | 'cohort'
  | 'peer-dropped'
  | 'moved-recently'
  | 'unknown-leave-region'
  | 'target-room'
  | 'source-budget'
  | 'not-placed'

type Identity = { userId: string; relayHostId: string }

// Free seats and summed ceilings over the target region's reserve candidates, and whether one
// of them has a seat and an intake token.
export type RehomeTargetRoom = { free: number; ceiling: number; bookable: boolean }

export class ReserveRehome {
  // Insertion order is age order, so the oldest entry is dropped first.
  private readonly moved = new Map<string, number>()
  private readonly budgets = new Map<string, { tokens: number; refilledAt: number }>()

  constructor(
    private readonly input: {
      // 0-100 of hosts by hash; 0 is off.
      percent: number
      switchOpen: (now: number) => boolean
    }
  ) {}

  get enabled(): boolean {
    return this.input.percent > 0
  }

  // For a reserve host outside its region, return first failing admission rule or take source token and return null.
  admit(input: {
    identity: Identity
    sourceCellId: string
    // The source cell's live controls, for its per-minute budget.
    sourceControls: number
    // Every remembered leave of the host (24 h), with the region of the cell it left.
    leaves: readonly { region: RelayRegion | undefined; closeCode?: number; at: number }[]
    target: RehomeTargetRoom
    now: number
  }): RehomeSkip | null {
    const { identity, now } = input
    if (!this.input.switchOpen(now)) {
      return 'switch'
    }
    if (hostCohortBucket(identity) >= this.input.percent) {
      return 'cohort'
    }
    if (
      input.leaves.some(
        (leave) => leave.closeCode === RELAY_CLOSE_CODE.PEER_DROPPED && now - leave.at <= RESERVE_REHOME_PEER_DROPPED_MS
      )
    ) {
      return 'peer-dropped'
    }
    const leftRegions = new Set(input.leaves.map((leave) => leave.region))
    // A leave on a cell no longer listed: its region is unknown, so the host stays.
    if (leftRegions.has(undefined)) {
      return 'unknown-leave-region'
    }
    const movedAt = this.moved.get(hostKey(identity))
    const movedByThisDirector = movedAt !== undefined && now - movedAt < RESERVE_REHOME_HOST_COOLDOWN_MS
    if (leftRegions.size > 1 || movedByThisDirector) {
      return 'moved-recently'
    }
    const { free, ceiling, bookable } = input.target
    if (!bookable || ceiling <= 0 || free < RESERVE_REHOME_TARGET_FREE_SHARE * ceiling) {
      return 'target-room'
    }
    const budget = this.refill(input.sourceCellId, input.sourceControls, now)
    if (budget.tokens < 1) {
      return 'source-budget'
    }
    budget.tokens -= 1
    return null
  }

  // The booking was not made: the token goes back, and the host stays sticky.
  refund(sourceCellId: string): void {
    const budget = this.budgets.get(sourceCellId)
    if (budget) {
      budget.tokens = Math.min(1, budget.tokens + 1)
    }
  }

  recordMoved(identity: Identity, now: number): void {
    const key = hostKey(identity)
    this.moved.delete(key)
    this.moved.set(key, now)
    if (this.moved.size > RESERVE_REHOME_MOVED_MAX) {
      this.moved.delete(this.moved.keys().next().value!)
    }
  }

  // Fractional refill, burst 1. A new director starts empty, so a deploy cannot burst.
  private refill(cellId: string, controls: number, now: number) {
    let budget = this.budgets.get(cellId)
    if (!budget) {
      budget = { tokens: 0, refilledAt: now }
      this.budgets.set(cellId, budget)
    }
    const minutes = Math.max(0, now - budget.refilledAt) / 60_000
    budget.tokens = Math.min(1, budget.tokens + minutes * controls * RESERVE_REHOME_SOURCE_SHARE_PER_MINUTE)
    budget.refilledAt = now
    return budget
  }
}

function hostKey(identity: Identity): string {
  return `${identity.userId}\u0000${identity.relayHostId}`
}

// Cache operator regional rehome switch; unknown/failed/stale means off. Poll only enabled directors.
export class ReserveRehomeSwitch {
  private last: { enabled: boolean; notBefore: number; readAt: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  // One read at a time, so a stalled read cannot land after a newer one and reopen the switch.
  private reading = false

  constructor(
    private readonly read: () => Promise<{ enabled: boolean; notBefore: number } | null>,
    private readonly now: () => number = Date.now
  ) {}

  isOpen(now: number): boolean {
    const last = this.last
    return (
      last !== null && last.enabled && last.notBefore <= now && now - last.readAt <= RESERVE_REHOME_SWITCH_STALE_MS
    )
  }

  async refresh(): Promise<void> {
    if (this.reading) {
      return
    }
    this.reading = true
    // Stamped when the read starts: a slow answer is only as fresh as its question.
    const readAt = this.now()
    try {
      const control = await this.read()
      this.last = control ? { ...control, readAt } : null
    } catch {
      this.last = null
    } finally {
      this.reading = false
    }
  }

  start(): void {
    if (this.timer) {
      return
    }
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), RESERVE_REHOME_SWITCH_POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.timer = null
  }
}
