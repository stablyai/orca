// Per-connection liveness timers for the iroh transport: a pre-auth deadline
// (unauthenticated peers must complete E2EE quickly) and an idle reaper
// (no inbound frames — QUIC keepalive covers the path, not the peer app).
import type { IrohFramedSocket } from './iroh-framed-socket'

export class IrohConnectionTimers {
  private readonly preAuth = new WeakMap<IrohFramedSocket, ReturnType<typeof setTimeout>>()
  private readonly idle = new WeakMap<IrohFramedSocket, ReturnType<typeof setTimeout>>()
  private readonly idleHandlers = new WeakMap<IrohFramedSocket, () => void>()

  constructor(
    private readonly preAuthTimeoutMs: number,
    private readonly idleTimeoutMs: number
  ) {}

  armPreAuth(socket: IrohFramedSocket, onExpired: () => void): void {
    const timer = setTimeout(onExpired, this.preAuthTimeoutMs)
    timer.unref?.()
    this.preAuth.set(socket, timer)
  }

  clearPreAuth(socket: IrohFramedSocket): void {
    const timer = this.preAuth.get(socket)
    if (timer) {
      clearTimeout(timer)
      this.preAuth.delete(socket)
    }
  }

  /** (Re-)arm the idle reaper; the handler from the first call is retained. */
  armIdle(socket: IrohFramedSocket, onIdle?: () => void): void {
    if (onIdle) {
      this.idleHandlers.set(socket, onIdle)
    }
    this.clearIdle(socket)
    const handler = this.idleHandlers.get(socket)
    const timer = setTimeout(() => {
      handler?.()
    }, this.idleTimeoutMs)
    timer.unref?.()
    this.idle.set(socket, timer)
  }

  clearIdle(socket: IrohFramedSocket): void {
    const timer = this.idle.get(socket)
    if (timer) {
      clearTimeout(timer)
      this.idle.delete(socket)
    }
  }
}
