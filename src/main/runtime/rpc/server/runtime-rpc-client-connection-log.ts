import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'

type ConnectionSocket = Pick<AuthenticatedMobileSocket, 'connectionId' | 'device' | 'transport'>

type DeviceActivity = {
  readonly label: string
  connected: number
  disconnected: number
  open: number
}

const CLIENT_ACTIVITY_WINDOW_MS = 10 * 60_000

/** Who connected, without credentials: a phone's clientId can be its bearer token, so it is never logged. */
function describeDevice(socket: ConnectionSocket): string {
  return `device=${socket.device.deviceId} scope=${socket.device.scope} transport=${socket.transport.transport}`
}

/**
 * Shows which client was attached when (#40328) at a volume set by devices, not call rate:
 * a CLI opens one socket per command, so per-socket lines grew without bound.
 */
export class RuntimeClientConnectionLog {
  private readonly devices = new Map<string, DeviceActivity>()
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly write: (line: string) => void = (line) => console.info(line)) {}

  record(event: 'connected' | 'disconnected', socket: ConnectionSocket): void {
    // Late callbacks from a stopped server's sockets belong to no session.
    if (this.closed) {
      return
    }
    const label = describeDevice(socket)
    let activity = this.devices.get(label)
    if (!activity) {
      if (event === 'disconnected') {
        return
      }
      activity = { label, connected: 0, disconnected: 0, open: 0 }
      this.devices.set(label, activity)
      this.write(`[runtime-rpc] client connected ${label} connection=${socket.connectionId}`)
      this.ensureTimer()
    }
    if (event === 'connected') {
      activity.connected += 1
      activity.open += 1
    } else {
      activity.disconnected += 1
      activity.open = Math.max(0, activity.open - 1)
    }
  }

  /** Closes the current window: one summary per device that changed, forgetting idle ones. */
  flushWindow(includeOpen = false): void {
    for (const [label, activity] of this.devices) {
      const quiet = activity.connected === 0 && activity.disconnected === 0
      if (quiet && !(includeOpen && activity.open > 0)) {
        if (activity.open === 0) {
          this.devices.delete(label)
        }
        continue
      }
      this.write(
        `[runtime-rpc] client activity ${label} connected=${activity.connected} disconnected=${activity.disconnected} open=${activity.open}`
      )
      activity.connected = 0
      activity.disconnected = 0
    }
    if (this.devices.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * The server stopped: record every device still attached (some transports close after this),
   * then start fresh so a missed close can't skew later counts.
   */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.flushWindow(true)
    this.devices.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureTimer(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => this.flushWindow(), CLIENT_ACTIVITY_WINDOW_MS)
    // Logging alone must never keep the process alive.
    this.timer.unref()
  }
}
