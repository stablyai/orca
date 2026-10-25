import type { WebSocket } from 'ws'
import { startSpan } from '../../observability/tracer'

// Cellular/Tailscale loss may swallow one pong (STA-3320); require consecutive misses. Three matches web-client tolerance after initial grace.
const MISSED_PROBE_LIMIT = 3

export class RemoteRuntimeServerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt: number | null = null
  private readonly alive = new WeakSet<WebSocket>()
  // Absent miss count means zero without retaining state for live sockets.
  private readonly missedProbes = new WeakMap<WebSocket, number>()
  private readonly trackedAt = new WeakMap<WebSocket, number>()
  private readonly unansweredPingAt = new WeakMap<WebSocket, number>()
  private readonly lastRttMs = new WeakMap<WebSocket, number>()

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly warningClientCount = 128,
    private readonly missedProbeLimit = MISSED_PROBE_LIMIT
  ) {}

  // Inbound hot path only marks life; the sweep resets misses.
  noteAlive(socket: WebSocket): void {
    this.alive.add(socket)
  }

  /** Starts the socket's uptime clock, reported if it is ever reaped. */
  track(socket: WebSocket): void {
    this.trackedAt.set(socket, this.now())
  }

  notePong(socket: WebSocket): void {
    this.noteAlive(socket)
    const sentAt = this.unansweredPingAt.get(socket)
    if (sentAt !== undefined) {
      this.unansweredPingAt.delete(socket)
      const rttMs = this.now() - sentAt
      if (rttMs >= 0) {
        this.lastRttMs.set(socket, rttMs)
      }
    }
  }

  start(getClients: () => Iterable<WebSocket>): void {
    if (this.timer) {
      return
    }
    this.lastTickAt = this.now()
    this.timer = setInterval(() => this.sweep(getClients()), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.lastTickAt = null
  }

  private sweep(clients: Iterable<WebSocket>): void {
    const tickAt = this.now()
    const elapsedMs = tickAt - (this.lastTickAt ?? tickAt)
    this.lastTickAt = tickAt
    // A delayed tick cannot charge a probe clients could not answer, but clearing banked misses would shelter dead sockets forever.
    // Preserve the count; responsive clients clear it by answering the next probe.
    const stalledTick = elapsedMs < 0 || elapsedMs > this.intervalMs * 1.5
    let reaped = 0
    const reapedSockets: WebSocket[] = []
    let clientCount = 0
    for (const socket of clients) {
      clientCount += 1
      if (this.alive.has(socket)) {
        this.alive.delete(socket)
        this.missedProbes.delete(socket)
      } else if (!stalledTick) {
        const missed = (this.missedProbes.get(socket) ?? 0) + 1
        if (missed >= this.missedProbeLimit) {
          this.missedProbes.delete(socket)
          socket.terminate()
          reaped += 1
          reapedSockets.push(socket)
          continue
        }
        this.missedProbes.set(socket, missed)
      }
      try {
        // Re-probe even after misses so recovered paths can immediately prove life.
        socket.ping()
        if (!this.unansweredPingAt.has(socket) || stalledTick) {
          this.unansweredPingAt.set(socket, tickAt)
        }
      } catch {
        // Close/error listeners finalize sockets already tearing down.
      }
    }
    for (const socket of reapedSockets) {
      this.traceReap(socket, tickAt, clientCount)
    }
    if (reaped > 0 || clientCount >= this.warningClientCount) {
      console.warn(`[ws-transport] heartbeat reaped ${reaped}; ${clientCount} tracked sockets`)
    }
  }

  // Why: the console line reaches nothing in a packaged host; a span lands in the support bundle.
  private traceReap(socket: WebSocket, reapedAt: number, trackedSockets: number): void {
    const trackedAt = this.trackedAt.get(socket)
    startSpan('remote-runtime.server-socket-reaped', {
      kind: 'server',
      attributes: {
        cause: 'heartbeat_missed_probes',
        missedProbes: this.missedProbeLimit,
        intervalMs: this.intervalMs,
        lastRttMs: this.lastRttMs.get(socket) ?? null,
        socketUptimeMs: trackedAt === undefined ? null : reapedAt - trackedAt,
        trackedSockets
      }
    }).end()
  }
}
