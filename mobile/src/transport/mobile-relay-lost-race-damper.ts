// Paces the direct-vs-relay reconnect race after the relay dial loses it. A lost
// race books no failure — that is deliberate, since losing is the good outcome —
// so nothing else stops a flapping LAN from opening one cell socket per blip, and
// the relay's per-host rate limiter would eventually turn a benign race into a
// booked relay failure. This is not backoff: it never delays the failure path,
// and its window lapse re-enters recovery so a LAN that dies mid-window still
// reaches relay on its own.
const INITIAL_DAMP_MS = 2_000
const MAX_DAMP_MS = 30_000

type LostRaceDamperDependencies = {
  now: () => number
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class RelayLostRaceDamper {
  private windowMs = 0
  private suppressUntil = 0
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
    this.clearTimer()
    this.timer = this.dependencies.setTimer(() => {
      this.timer = null
      this.onWindowLapse()
    }, this.windowMs)
  }

  // A relay dial that wins, or the user bringing the app back, ends the streak:
  // neither is a blip, and a resume must never wait out a damper window.
  reset(): void {
    this.windowMs = 0
    this.suppressUntil = 0
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer) {
      this.dependencies.clearTimer(this.timer)
      this.timer = null
    }
  }
}
