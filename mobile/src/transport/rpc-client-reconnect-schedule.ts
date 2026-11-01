import { isAppOutsideForeground } from './socket-deadline-clock'

const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000]
export const RPC_RECONNECT_ATTEMPT_LIMIT = 12
const TRICKLE_RECONNECT_DELAY_MS = 90_000
// A paired host that never answered this session is likely offline on purpose (#13354).
const NEVER_CONNECTED_TRICKLE_DELAY_MS = 5 * 60_000

type ReconnectScheduleOptions = {
  openConnection: () => void
  rejectConnectWaiters: (reason: string) => void
  emitLog: (message: string, detail: string) => void
}

export class RpcClientReconnectSchedule {
  private attempt = 0
  private connectedOnce = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: ReconnectScheduleOptions) {}

  getAttempt(): number {
    return this.attempt
  }

  authenticated(): void {
    this.attempt = 0
    this.connectedOnce = true
  }

  schedule(): void {
    const trickle = this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
    // The failure that uses up the limit already moves a never-connected host to its slow retry.
    const enteringDormant = !this.connectedOnce && this.attempt + 1 >= RPC_RECONNECT_ATTEMPT_LIMIT
    const slow = trickle || enteringDormant
    let delayMs: number
    if (slow) {
      delayMs = this.connectedOnce ? TRICKLE_RECONNECT_DELAY_MS : NEVER_CONNECTED_TRICKLE_DELAY_MS
      this.options.rejectConnectWaiters('Connection retry limit reached')
    } else {
      delayMs = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)]!
    }
    this.attempt = Math.min(this.attempt + 1, RPC_RECONNECT_ATTEMPT_LIMIT)
    console.log('[net] scheduleReconnect', {
      delayMs,
      attempt: this.attempt,
      trickle: slow,
      dormant: this.isDormant()
    })
    this.options.emitLog(
      `Reconnect scheduled in ${delayMs}ms`,
      slow ? `Attempt ${this.attempt} (slow retry)` : `Attempt ${this.attempt}`
    )
    this.arm(delayMs)
  }

  // Pull the next attempt forward; only authenticated() forgets the failures behind it.
  redialOnNudge(): void {
    if (this.isDormant()) {
      console.log('[net] nudge ignored — never-connected host stays on its slow retry')
      return
    }
    this.cancel()
    this.options.openConnection()
  }

  hasTimer(): boolean {
    return this.timer !== null
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // Only the slow trickle or a new client (manual retry, re-pairing) dials a dormant host.
  private isDormant(): boolean {
    return !this.connectedOnce && this.attempt >= RPC_RECONNECT_ATTEMPT_LIMIT
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.isDormant() && isAppOutsideForeground()) {
        this.arm(delayMs)
        return
      }
      this.options.openConnection()
    }, delayMs)
  }
}
