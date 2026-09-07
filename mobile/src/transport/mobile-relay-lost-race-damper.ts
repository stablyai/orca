// Paces the direct-vs-relay reconnect race after the relay dial loses it. A lost
// race books no failure — that is deliberate, since losing is the good outcome —
// so nothing else stops a flapping LAN from opening one cell socket per blip, and
// the relay's per-host rate limiter would eventually turn a benign race into a
// booked relay failure. This is not backoff: it never delays the failure path,
// and its window lapse re-enters recovery so a LAN that dies mid-window still
// reaches relay on its own.
const INITIAL_DAMP_MS = 2_000
const MAX_DAMP_MS = 30_000
// How long a lost direct path is given to prove it was only a blip. Long enough
// to absorb one that drops and comes straight back, short enough that a real
// outage never reads as the connection being stuck.
const LOST_DIRECT_FLOOR_MS = 250

type LostRaceDamperDependencies = {
  now: () => number
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class RelayLostRaceDamper {
  private windowMs = 0
  private suppressUntil = 0
  // The window held aside while a lost direct path proves whether it was a blip.
  private pendingUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dependencies: LostRaceDamperDependencies,
    private readonly onWindowLapse: () => void
  ) {}

  suppresses(): boolean {
    return this.dependencies.now() < this.suppressUntil
  }

  // Each successive loss inside the window doubles it, so a LAN that flaps all
  // afternoon settles at one race per 30s instead of one per blip.
  record(): void {
    this.windowMs = this.windowMs === 0 ? INITIAL_DAMP_MS : Math.min(this.windowMs * 2, MAX_DAMP_MS)
    this.suppressUntil = this.dependencies.now() + this.windowMs
    this.arm(this.windowMs)
  }

  // The direct path that won the last race is gone. Collapse the wait to the
  // floor, so an outage is never held off for the window a blip earned, and keep
  // the rest of that window aside rather than spending it: one blip must not buy
  // a flapping LAN a free pass on every race that follows.
  clampForLostDirect(): void {
    const floorAt = this.dependencies.now() + LOST_DIRECT_FLOOR_MS
    if (this.suppressUntil === 0 || this.pendingUntil !== 0 || this.suppressUntil <= floorAt) {
      return
    }
    this.pendingUntil = this.suppressUntil
    this.suppressUntil = floorAt
    this.arm(LOST_DIRECT_FLOOR_MS)
  }

  // Direct came back inside the floor, so that was the blip this exists for and
  // the rest of the window still has to run.
  noteDirectRestored(): void {
    if (this.pendingUntil === 0) {
      return
    }
    this.suppressUntil = this.pendingUntil
    this.pendingUntil = 0
    this.arm(Math.max(0, this.suppressUntil - this.dependencies.now()))
  }

  // A relay dial that wins, or the user bringing the app back, ends the streak:
  // neither is a blip, and a resume must never wait out a damper window. A relay
  // failure deliberately does not — it is not evidence the LAN stopped flapping,
  // and its own cooldown runs after this window rather than on top of it, since
  // a damped attempt never reaches the dial that would book one.
  reset(): void {
    this.windowMs = 0
    this.suppressUntil = 0
    this.pendingUntil = 0
    this.clearTimer()
  }

  private arm(delayMs: number): void {
    this.clearTimer()
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      // Why: the floor lapsed with direct still gone, so it was an outage and the
      // window held aside is void — a later return must not resurrect it.
      this.pendingUntil = 0
      this.onWindowLapse()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }
}
