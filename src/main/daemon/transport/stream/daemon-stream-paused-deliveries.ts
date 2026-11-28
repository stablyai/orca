// A stalled session resumes without shedding only when its own output was delivered this recently.
const DELIVERY_PROGRESS_WINDOW_MS = 10_000

/** Each paused session's own completed writes since it paused, indexed by client so a closing connection drops only its own. */
export class PausedSessionDeliveries {
  private readonly deliveredAt = new Map<string, { at: number; clientId: string }>()
  private readonly sessionsByClient = new Map<string, Set<string>>()

  credit(sessionId: string, clientId: string): void {
    const previous = this.deliveredAt.get(sessionId)
    if (previous && previous.clientId !== clientId) {
      this.forget(sessionId)
    }
    this.deliveredAt.set(sessionId, { at: Date.now(), clientId })
    let sessions = this.sessionsByClient.get(clientId)
    if (!sessions) {
      sessions = new Set()
      this.sessionsByClient.set(clientId, sessions)
    }
    sessions.add(sessionId)
  }

  progressed(sessionId: string): boolean {
    const delivered = this.deliveredAt.get(sessionId)
    return delivered !== undefined && Date.now() - delivered.at < DELIVERY_PROGRESS_WINDOW_MS
  }

  forget(sessionId: string): void {
    const delivered = this.deliveredAt.get(sessionId)
    if (!delivered) {
      return
    }
    this.deliveredAt.delete(sessionId)
    const sessions = this.sessionsByClient.get(delivered.clientId)
    sessions?.delete(sessionId)
    if (sessions?.size === 0) {
      this.sessionsByClient.delete(delivered.clientId)
    }
  }

  /** A dead connection's deliveries prove nothing about the session's current consumer. */
  forgetClient(clientId: string): void {
    for (const sessionId of this.sessionsByClient.get(clientId) ?? []) {
      this.deliveredAt.delete(sessionId)
    }
    this.sessionsByClient.delete(clientId)
  }

  clear(): void {
    this.deliveredAt.clear()
    this.sessionsByClient.clear()
  }
}
