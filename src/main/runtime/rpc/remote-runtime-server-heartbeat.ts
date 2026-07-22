import type { WebSocket } from 'ws'

export class RemoteRuntimeServerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt: number | null = null
  private readonly alive = new WeakSet<WebSocket>()

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly warningClientCount = 128
  ) {}

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
    // Why: the interval's first tick is a full intervalMs (~15s) out, so arming on the first accepted
    // connection would leave that socket unprobed for the whole window. Sweep once now so the first
    // liveness ping goes out immediately; seeded-alive sockets are pinged (not reaped) and have until
    // the next tick to pong. WS pong is answered at the protocol level, so a live socket always survives.
    this.sweep(getClients())
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
    const resumedFromPause = elapsedMs < 0 || elapsedMs > this.intervalMs * 1.5
    let reaped = 0
    let clientCount = 0
    for (const socket of clients) {
      clientCount += 1
      if (resumedFromPause) {
        // Why: a delayed server tick cannot infer that clients missed a probe they had no chance to answer.
        this.alive.add(socket)
      }
      if (!this.alive.has(socket)) {
        socket.terminate()
        reaped += 1
        continue
      }
      this.alive.delete(socket)
      try {
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
