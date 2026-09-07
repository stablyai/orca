import type { WebSocket } from 'ws'

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
          continue
        }
        this.missedProbes.set(socket, missed)
      }
      try {
        // Why: re-probe every sweep, including missed ones, so a path that just recovered can prove
        // itself on the next tick instead of waiting out the rest of the budget.
        socket.ping()
      } catch {
        // Why: a mid-teardown socket is finalized by its close/error listener.
      }
    }
    if (reaped > 0 || clientCount >= this.warningClientCount) {
      console.warn(`[ws-transport] heartbeat reaped ${reaped}; ${clientCount} tracked sockets`)
    }
  }
}
