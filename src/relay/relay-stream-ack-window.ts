import { STREAM_ACK_STALL_RECHECK_MS } from './protocol'

/** Waiters wake on ack, abort, or a stall recheck so a vanished client cannot strand a pump. */
export class RelayStreamAckWindow {
  aborted = false
  /** Highest chunk seq the client acknowledged (in-order; -1 = none yet). */
  ackedThroughSeq = -1
  private readonly waiters = new Set<() => void>()

  recordAck(seq: number): void {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) {
      return
    }
    if (seq > this.ackedThroughSeq) {
      this.ackedThroughSeq = seq
    }
    this.wake()
  }

  abort(): void {
    this.aborted = true
    this.wake()
  }

  wake(): void {
    for (const waiter of Array.from(this.waiters)) {
      waiter()
    }
  }

  wait(): Promise<void> {
    if (this.aborted) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        this.waiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, STREAM_ACK_STALL_RECHECK_MS)
      timer.unref?.()
      this.waiters.add(finish)
    })
  }
}
