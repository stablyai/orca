// Why: a connected daemon that stops reading must not accumulate abandoned snapshot requests.
const RECOVERY_SNAPSHOT_CREDIT = 8

/** Gap-recovery snapshots written but not yet proven read, per control connection. */
export class DaemonRecoveryCredit {
  // Request seq -> session; insertion order is send order.
  private readonly owed = new Map<number, string>()
  private probeSeq: number | null = null

  /** The daemon reads requests in order, so any reply to req-N proves every request up to N left the transport. */
  observeReply(id: unknown): void {
    const seq = requestSeq(id)
    if (seq === null) {
      return
    }
    for (const owedSeq of this.owed.keys()) {
      if (owedSeq > seq) {
        break
      }
      this.owed.delete(owedSeq)
    }
    if (this.probeSeq !== null && this.probeSeq <= seq) {
      this.probeSeq = null
    }
  }

  /** Whether another snapshot for this session may be written now; one unproven request per session. */
  private admits(sessionId: string): boolean {
    if (this.owed.size >= RECOVERY_SNAPSHOT_CREDIT) {
      return false
    }
    for (const owedSession of this.owed.values()) {
      if (owedSession === sessionId) {
        return false
      }
    }
    return true
  }

  /** A refusal sends one probe whose reply proves earlier requests were read; it is never re-sent while owed. */
  private takeProbe(nextSeq: number): boolean {
    if (this.probeSeq !== null) {
      return false
    }
    this.probeSeq = nextSeq
    return true
  }

  private charge(seq: number, sessionId: string): void {
    this.owed.set(seq, sessionId)
  }

  /** Null instead of another request while the daemon has not read earlier ones; `nextSeq` is the id `send` takes. */
  send<T>(
    sessionId: string,
    nextSeq: number,
    sendSnapshot: () => Promise<T>,
    sendProbe: () => Promise<unknown>
  ): Promise<T | null> {
    if (!this.admits(sessionId)) {
      if (this.takeProbe(nextSeq)) {
        void sendProbe().catch(() => {})
      }
      return Promise.resolve(null)
    }
    // A timeout or abort leaves the charge until a reply proves the request was read.
    this.charge(nextSeq, sessionId)
    return sendSnapshot()
  }

  /** A new connection carries none of the old one's unread requests. */
  reset(): void {
    this.owed.clear()
    this.probeSeq = null
  }
}

function requestSeq(id: unknown): number | null {
  if (typeof id !== 'string' || !id.startsWith('req-')) {
    return null
  }
  const seq = Number(id.slice(4))
  return Number.isSafeInteger(seq) ? seq : null
}
