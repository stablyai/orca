import type { WebSocket } from 'ws'
import { startSpan } from '../../observability/tracer'

// Why: one unanswered probe is UNKNOWN, not death — a cellular/Tailscale blackhole or a stalled TCP
// retransmit routinely swallows a single pong from a peer that is still there (STA-3320). Only a run of
// consecutive unanswered probes is evidence. Three matches the web client's liveness budget, so both
// ends of a paired session give up on roughly the same evidence after the initial grace interval.
const MISSED_PROBE_LIMIT = 3

export class RemoteRuntimeServerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt: number | null = null
  private readonly alive = new WeakSet<WebSocket>()
  // Why: consecutive probes a socket has left unanswered. Absent = zero, so live sockets cost nothing.
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

  // Why: hot path — every inbound frame calls this. The sweep clears the miss count when it observes
  // the flag, so proof of life stays a single WeakSet write.
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
    // Why: a delayed tick cannot infer that clients missed a probe they had no chance to answer, so
    // this sweep must not charge one. It must not *forgive* either: clearing banked misses lets a host
    // that stalls once every few ticks protect a dead socket forever, which is the connection leak the
    // reaper exists to prevent. Skipping the charge is enough — a live client clears its own count by
    // answering the probe still sent below.
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
        // Why: re-probe every sweep, including missed ones, so a path that just recovered can prove
        // itself on the next tick instead of waiting out the rest of the budget.
        socket.ping()
        if (!this.unansweredPingAt.has(socket) || stalledTick) {
          this.unansweredPingAt.set(socket, tickAt)
        }
      } catch {
        // Why: a mid-teardown socket is finalized by its close/error listener.
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
