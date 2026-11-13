// Edge keepalives are answered without the host being seated, so a live control does not prove
// phones can reach this desktop. Failed data attaches do; enough of them re-ask the director.
const FAILURE_STREAK_LIMIT = 2
const FAILURE_STREAK_WINDOW_MS = 2 * 60_000
// A phone that keeps redialing must not turn into director traffic.
const RECOVERY_MIN_INTERVAL_MS = 60_000

export class RelayDataAttachHealth {
  private streak = 0
  private streakStartedAt = 0
  private lastRecoveryAt: number | null = null

  constructor(
    private readonly cellUrl: string,
    private readonly onUnhealthy: () => void
  ) {}

  note(attached: boolean): void {
    if (attached) {
      this.streak = 0
      return
    }
    const now = Date.now()
    if (this.streak === 0 || now - this.streakStartedAt > FAILURE_STREAK_WINDOW_MS) {
      this.streak = 0
      this.streakStartedAt = now
    }
    this.streak += 1
    console.warn(`[relay] data attach failed cell=${this.cellUrl} streak=${this.streak}`)
    if (
      this.streak < FAILURE_STREAK_LIMIT ||
      (this.lastRecoveryAt !== null && now - this.lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS)
    ) {
      return
    }
    this.lastRecoveryAt = now
    this.streak = 0
    console.warn(`[relay] data attaches failing; asking director again cell=${this.cellUrl}`)
    this.onUnhealthy()
  }
}
