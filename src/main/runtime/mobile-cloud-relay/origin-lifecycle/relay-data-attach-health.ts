// Edge keepalives are answered without the host being seated, so a live control does not prove
// phones can reach this desktop. This host failing to even open its data dials does: that is the
// lossy-path signature behind phones' 4404 attach-timeout. Phone behaviour after open is ignored.
const FAILED_CONNECTION_LIMIT = 2
const FAILURE_WINDOW_MS = 2 * 60_000

export class RelayDataAttachHealth {
  // Distinct connections: one phone's replayed pending attach must not count twice.
  private readonly failedConnections = new Set<string>()
  private windowStartedAt = 0

  constructor(
    private readonly cellUrl: string,
    private readonly onUnhealthy: () => void
  ) {}

  note(connectionId: string, opened: boolean): void {
    if (opened) {
      this.failedConnections.clear()
      return
    }
    const now = Date.now()
    if (this.failedConnections.size === 0 || now - this.windowStartedAt > FAILURE_WINDOW_MS) {
      this.failedConnections.clear()
      this.windowStartedAt = now
    }
    this.failedConnections.add(connectionId)
    const streak = this.failedConnections.size
    console.warn(`[relay] data attach failed cell=${this.cellUrl} streak=${streak}`)
    if (streak >= FAILED_CONNECTION_LIMIT) {
      this.failedConnections.clear()
      this.onUnhealthy()
    }
  }
}
