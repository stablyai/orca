import type { RelayControlOrigin } from './relay-control-origin'
import type { RelayAssignment } from './relay-http-client'
import { relayRenewalDelayMs } from './relay-renewal-jitter'

type RotationOptions = {
  current: () => RelayControlOrigin | null
  available: () => boolean
  token: () => string | null
  assignment: () => RelayAssignment | null
  busy: () => boolean
  now?: () => number
  random?: () => number
}
export class RelayControlRotation {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly options: RotationOptions) {}
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }
  schedule(): void {
    this.cancel()
    const origin = this.options.current()
    if (!origin || !this.options.available()) {
      return
    }
    const delay = relayRenewalDelayMs(
      origin.controlLeaseExpiresAt,
      (this.options.now ?? Date.now)(),
      this.options.random ?? Math.random
    )
    this.timer = setTimeout(() => void this.rebind(origin), delay)
  }
  private async rebind(origin: RelayControlOrigin): Promise<void> {
    this.timer = null
    if (!this.options.available() || origin !== this.options.current()) {
      return
    }
    if (this.options.busy()) {
      this.timer = setTimeout(() => void this.rebind(origin), 5_000)
      return
    }
    const token = this.options.token()
    const assignment = this.options.assignment()
    if (!token || !assignment) {
      return
    }
    try {
      await origin.rebind(token, assignment)
      if (this.options.available() && origin === this.options.current()) {
        this.schedule()
      }
    } catch {
      if (this.options.available() && origin === this.options.current()) {
        this.timer = setTimeout(
          () => void this.rebind(origin),
          5_000 + Math.floor((this.options.random ?? Math.random)() * 10_001)
        )
      }
    }
  }
}
