import { encodeStreamDataEvent } from './daemon-stream-data-split'

export class DaemonStreamHeldRefill {
  private readonly armed = new Map<string, symbol>()

  constructor(private readonly flush: (clientId: string) => void) {}

  arm(
    clientId: string,
    sessionId: string,
    write: (line: string, complete: () => void) => void
  ): void {
    if (this.armed.has(clientId)) {
      return
    }
    const refill = Symbol()
    this.armed.set(clientId, refill)
    // A real no-op frame waits for preceding writes; an empty write can complete immediately.
    write(encodeStreamDataEvent(sessionId, ''), () => {
      if (this.armed.get(clientId) !== refill) {
        return
      }
      this.armed.delete(clientId)
      this.flush(clientId)
    })
  }

  clear(clientId?: string): void {
    if (clientId === undefined) {
      this.armed.clear()
    } else {
      this.armed.delete(clientId)
    }
  }
}
