import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

// Why: every accepted socket must sit under exactly one liveness bound at all times — the pre-auth
// deadline until it authenticates, the heartbeat reaper after. Owning both transitions here means a
// future long-lived unauthenticated flow cannot silently opt out of policing (STA-3231 follow-up);
// it would need an explicit exemption in this class.
export class AcceptedSocketLiveness {
  private readonly heartbeat: RemoteRuntimeServerHeartbeat
  private readonly accepted = new Set<WebSocket>()
  // Why: heartbeat probes only authenticated sockets — control frames during the E2EE handshake
  // close strict native mobile WS stacks with 1006 (issue #12140).
  private readonly authenticated = new Set<WebSocket>()
  private readonly preAuthTimers = new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly preAuthTimeoutMs: number,
    heartbeatIntervalMs: number,
    heartbeatNow?: () => number,
    warningClientCount?: number
  ) {
    this.heartbeat = new RemoteRuntimeServerHeartbeat(
      heartbeatIntervalMs,
      heartbeatNow,
      warningClientCount
    )
  }

  accept(ws: WebSocket): void {
    this.accepted.add(ws)
    this.heartbeat.noteAlive(ws)
    const preAuthTimer = setTimeout(() => {
      if (!this.authenticated.has(ws)) {
        // Why: a silent auto-ponging client would otherwise hold a finite mobile slot forever without starting the E2EE handshake.
        ws.terminate()
      }
    }, this.preAuthTimeoutMs)
    preAuthTimer.unref?.()
    this.preAuthTimers.set(ws, preAuthTimer)
    if (this.accepted.size === 1) {
      this.heartbeat.start(() => this.authenticated)
    }
  }

  // Why: swaps the pre-auth deadline for heartbeat membership atomically, so the socket is never
  // under both bounds or neither.
  authenticate(ws: WebSocket): void {
    this.clearPreAuthTimer(ws)
    this.authenticated.add(ws)
  }

  noteAlive(ws: WebSocket): void {
    this.heartbeat.noteAlive(ws)
  }

  release(ws: WebSocket): void {
    this.clearPreAuthTimer(ws)
    this.accepted.delete(ws)
    this.authenticated.delete(ws)
    if (this.accepted.size === 0) {
      this.heartbeat.stop()
    }
  }

  stop(): void {
    this.heartbeat.stop()
    // Why: clearing membership here (not just timers) keeps a stop/start overlap from probing
    // terminated sockets whose close events have not flushed yet.
    this.accepted.clear()
    this.authenticated.clear()
  }

  private clearPreAuthTimer(ws: WebSocket): void {
    const timer = this.preAuthTimers.get(ws)
    if (timer) {
      clearTimeout(timer)
      this.preAuthTimers.delete(ws)
    }
  }
}
