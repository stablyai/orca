const RPC_TIMEOUT_RECYCLE_STREAK = 2

export class RpcApplicationResponsiveness {
  private unresponsiveSince: number | null = null
  private timeoutStreak = 0
  private readonly listeners = new Set<() => void>()

  // Why: latch/recovery are the only two transitions of unresponsiveSince —
  // subscribers re-read on notify, so the UI needs no polling.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  recordResponse(method: string, now = Date.now()): boolean {
    if (isRpcTransportControlMethod(method)) {
      return false
    }
    return this.recordApplicationResponse(now)
  }

  recordApplicationResponse(_now = Date.now()): boolean {
    const recovered = this.unresponsiveSince !== null
    this.unresponsiveSince = null
    this.timeoutStreak = 0
    if (recovered) {
      this.notifyChanged()
    }
    return recovered
  }

  // Why: the liveness probe recycles a wedged socket ~2s before an application
  // request can reach its own 30s timeout, so the demote is the only evidence that
  // the next successful handshake is still not a usable RPC channel (issue #10385).
  recordControlPlaneFailure(now = Date.now()): boolean {
    const latched = this.unresponsiveSince === null
    this.unresponsiveSince ??= now
    if (latched) {
      this.notifyChanged()
    }
    return latched
  }

  recordTimeout(now = Date.now()): { latched: boolean; recycle: boolean } {
    this.timeoutStreak += 1
    const latched = this.unresponsiveSince === null
    this.unresponsiveSince ??= now
    if (latched) {
      this.notifyChanged()
    }
    return { latched, recycle: this.timeoutStreak >= RPC_TIMEOUT_RECYCLE_STREAK }
  }

  getUnresponsiveSince(): number | null {
    return this.unresponsiveSince
  }

  private notifyChanged(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export function isRpcTransportControlMethod(method: string): boolean {
  return method === 'status.get' || method === 'pairing.getEndpoints'
}
