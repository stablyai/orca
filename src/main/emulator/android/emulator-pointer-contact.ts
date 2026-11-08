import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

export type EmulatorPointerContactPacket = {
  x: number
  y: number
  identifier: number
  pressure: number
}

export class EmulatorPointerContact {
  private current: EmulatorPointerContactPacket | null = null
  private pending: EmulatorPointerContactPacket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private beganAt = 0
  private origin: EmulatorPointerContactPacket | null = null

  constructor(private readonly send: (touch: EmulatorPointerContactPacket) => boolean) {}

  touch(phase: EmulatorGesturePoint['type'], point: { x: number; y: number }): boolean {
    if (phase === 'begin') {
      this.release()
      this.beganAt = performance.now()
      this.current = { ...point, identifier: 0, pressure: 1024 }
      this.origin = this.current
      return this.send(this.current)
    }
    if (!this.current) {
      return phase === 'end'
    }
    if (phase === 'end') {
      this.current = { ...this.current, ...point }
      return this.release()
    }
    this.current = { ...this.current, ...point }
    // Separate initial touch contact from motion so Android does not merge them into a tap.
    const delay = 16 - (performance.now() - this.beganAt)
    if (delay > 0) {
      this.pending = this.current
      this.timer ??= setTimeout(() => this.flushPending(true), delay)
      return true
    }
    this.cancelPending()
    return this.send(this.current)
  }

  release(): boolean {
    this.cancelPending()
    const current = this.current
    this.current = null
    this.origin = null
    return current ? this.send({ ...current, pressure: 0 }) : true
  }

  private flushPending(initial: boolean): void {
    this.timer = null
    const pending = this.pending
    this.pending = null
    if (!pending || !this.current) {
      return
    }
    if (initial && this.origin) {
      const sent = this.send({
        ...pending,
        x: Math.round((this.origin.x + pending.x) / 2),
        y: Math.round((this.origin.y + pending.y) / 2)
      })
      if (!sent || !this.current) {
        return
      }
      this.pending = pending
      this.timer = setTimeout(() => this.flushPending(false), 16)
    } else {
      this.send(pending)
    }
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.pending = null
  }
}
