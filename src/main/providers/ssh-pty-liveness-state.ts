export const MAX_SSH_PTY_EXIT_TOMBSTONES = 1000

export type SshPtyLiveEvidence = { valid: boolean }
export type SshPtyLiveEvidenceWindow = {
  valid: boolean
  readonly invalidatedPtyIds: Set<string>
}

export class SshPtyLivenessState {
  readonly livePtyIds = new Set<string>()
  private readonly exitedPtyIds = new Set<string>()
  private readonly pendingLiveEvidenceByPtyId = new Map<string, Set<SshPtyLiveEvidence>>()
  private readonly liveEvidenceWindows = new Set<SshPtyLiveEvidenceWindow>()

  constructor(private readonly toAppPtyId: (id: string) => string) {}

  clear(): void {
    for (const evidence of this.pendingLiveEvidenceByPtyId.values()) {
      for (const pending of evidence) {
        pending.valid = false
      }
    }
    this.pendingLiveEvidenceByPtyId.clear()
    for (const window of this.liveEvidenceWindows) {
      window.valid = false
      window.invalidatedPtyIds.clear()
    }
    this.liveEvidenceWindows.clear()
    this.livePtyIds.clear()
    this.exitedPtyIds.clear()
  }

  probe(id: string): boolean | null {
    return this.livePtyIds.has(id) ? true : this.exitedPtyIds.has(id) ? false : null
  }

  acceptLive(id: string): void {
    const appPtyId = this.toAppPtyId(id)
    this.exitedPtyIds.delete(appPtyId)
    this.livePtyIds.add(appPtyId)
  }

  beginLiveEvidence(id: string, window?: SshPtyLiveEvidenceWindow): SshPtyLiveEvidence {
    const appPtyId = this.toAppPtyId(id)
    const evidence = {
      valid:
        window === undefined ||
        (window.valid &&
          this.liveEvidenceWindows.has(window) &&
          !window.invalidatedPtyIds.has(appPtyId))
    }
    if (!evidence.valid) {
      return evidence
    }
    const pending = this.pendingLiveEvidenceByPtyId.get(appPtyId) ?? new Set()
    pending.add(evidence)
    this.pendingLiveEvidenceByPtyId.set(appPtyId, pending)
    return evidence
  }

  beginLiveEvidenceWindow(): SshPtyLiveEvidenceWindow {
    const window = { valid: true, invalidatedPtyIds: new Set<string>() }
    this.liveEvidenceWindows.add(window)
    return window
  }

  closeLiveEvidenceWindow(window: SshPtyLiveEvidenceWindow): void {
    window.valid = false
    window.invalidatedPtyIds.clear()
    this.liveEvidenceWindows.delete(window)
  }

  settleLiveEvidence(id: string, evidence: SshPtyLiveEvidence, acceptLive: boolean): void {
    const appPtyId = this.toAppPtyId(id)
    const pending = this.pendingLiveEvidenceByPtyId.get(appPtyId)
    const wasPending = pending?.delete(evidence) === true
    if (pending?.size === 0) {
      this.pendingLiveEvidenceByPtyId.delete(appPtyId)
    }
    const wasValid = evidence.valid
    evidence.valid = false
    if (acceptLive && wasPending && wasValid) {
      this.acceptLive(appPtyId)
    }
  }

  acceptUnverifiable(id: string): void {
    const appPtyId = this.toAppPtyId(id)
    this.invalidatePendingLiveEvidence(appPtyId)
    this.livePtyIds.delete(appPtyId)
  }

  acceptExited(id: string): void {
    const appPtyId = this.toAppPtyId(id)
    this.refuseLiveEvidenceAfterExit(appPtyId)
    this.livePtyIds.delete(appPtyId)
    this.exitedPtyIds.delete(appPtyId)
    this.exitedPtyIds.add(appPtyId)
    if (this.exitedPtyIds.size > MAX_SSH_PTY_EXIT_TOMBSTONES) {
      const oldest = this.exitedPtyIds.values().next().value
      if (oldest !== undefined) {
        this.exitedPtyIds.delete(oldest)
      }
    }
  }

  // Why not a tombstone: an exit nobody could attribute leaves the verdict unverifiable. It differs
  // from acceptUnverifiable only in also refusing the live claims an open window could still settle.
  acceptUnverifiableExit(id: string): void {
    const appPtyId = this.toAppPtyId(id)
    this.acceptUnverifiable(appPtyId)
    this.refuseLiveEvidenceAfterExit(appPtyId)
  }

  // Why: an exit the owning host reported outranks every live claim an open window can still
  // produce, including one from a request issued after it — a reattach retries over the same id.
  private refuseLiveEvidenceAfterExit(appPtyId: string): void {
    for (const window of this.liveEvidenceWindows) {
      window.invalidatedPtyIds.add(appPtyId)
    }
    this.invalidatePendingLiveEvidence(appPtyId)
  }

  // Why: loss of contact is not evidence of death, so it stales only the claims already in flight;
  // a later request that does reach the host may still prove the PTY live.
  private invalidatePendingLiveEvidence(appPtyId: string): void {
    const pending = this.pendingLiveEvidenceByPtyId.get(appPtyId)
    if (!pending) {
      return
    }
    for (const evidence of pending) {
      evidence.valid = false
    }
    this.pendingLiveEvidenceByPtyId.delete(appPtyId)
  }
}
