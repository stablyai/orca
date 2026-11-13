import { RELAY_HOST_ATTACH_DEADLINE_MS } from '../control-channel/relay-control-protocol'

// Edge keepalives are answered without the host being seated, so a live control does not prove
// phones can reach this desktop. This host's data dials failing to open, or opening slowly, does:
// that is the lossy-path signature behind phones' 4404 attach-timeout. Phone behaviour after open
// is ignored.
const FAILED_CONNECTION_LIMIT = 2
const FAILURE_WINDOW_MS = 2 * 60_000
// The relay's attach window starts when it sends conn-open, ours when we receive it; a lossy path
// spends seconds on each. An open this late leaves host-data-auth likely to miss the relay's window.
const SLOW_OPEN_MS = RELAY_HOST_ATTACH_DEADLINE_MS / 2

export class RelayDataAttachHealth {
  // Distinct connections: one phone's replayed pending attach must not count twice.
  private readonly failedConnections = new Set<string>()
  private windowStartedAt = 0

  constructor(
    private readonly cellUrl: string,
    private readonly onUnhealthy: () => void
  ) {}

  note(connectionId: string, openedAfterMs: number | null): void {
    if (openedAfterMs !== null && openedAfterMs <= SLOW_OPEN_MS) {
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
    const dial = openedAfterMs === null ? 'unopened' : `slow openMs=${openedAfterMs}`
    console.warn(`[relay] data attach failed cell=${this.cellUrl} dial=${dial} streak=${streak}`)
    if (streak >= FAILED_CONNECTION_LIMIT) {
      this.failedConnections.clear()
      this.onUnhealthy()
    }
  }
}
