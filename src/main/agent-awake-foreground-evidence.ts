// Why: scans are event-driven, so expiry revalidates cached foreground state
// without adding process scans.
export const AGENT_AWAKE_FOREGROUND_AGENT_TTL_MS = 5 * 60 * 1000
const FOREGROUND_AGENT_REPORT_REFRESH_QUANTUM_MS = 5_000

type ForegroundAgentEvidence = {
  // Last time a real scan reported this PTY's recognized foreground agent.
  reportedAt: number
  // Refreshed by scans AND by cache revalidation at TTL expiry.
  observedAt: number
}

/** Per-PTY keep-awake evidence for recognized agents that emit no hook statuses. */
export class ForegroundAgentEvidenceLedger {
  private readonly evidenceByPtyId = new Map<string, ForegroundAgentEvidence>()
  private readonly now: () => number
  private readonly revalidate: ((ptyId: string) => boolean) | null

  constructor(args: { now: () => number; revalidate?: (ptyId: string) => boolean }) {
    this.now = args.now
    this.revalidate = args.revalidate ?? null
  }

  /** Returns true when the report changed the ledger (caller should refresh). */
  report(ptyId: string, agent: string | null): boolean {
    if (agent === null) {
      return this.evidenceByPtyId.delete(ptyId)
    }
    const now = this.now()
    const existing = this.evidenceByPtyId.get(ptyId)
    if (existing && now - existing.reportedAt < FOREGROUND_AGENT_REPORT_REFRESH_QUANTUM_MS) {
      return false
    }
    this.evidenceByPtyId.set(ptyId, { reportedAt: now, observedAt: now })
    return true
  }

  /** Drops expired evidence; counts what remains toward wake eligibility. */
  pruneAndCount(staleAfterMs: number): number {
    const now = this.now()
    for (const [ptyId, evidence] of this.evidenceByPtyId) {
      // Why: revalidation renews observedAt, so only an unconditional cap can
      // prevent evidence from surviving after its final timer.
      if (now - evidence.reportedAt >= staleAfterMs) {
        this.evidenceByPtyId.delete(ptyId)
        continue
      }
      // Why: strict `<` mirrors nextExpiry's `expiry <= now`, so a timer firing
      // exactly at the TTL boundary always renews or deletes, never stalls.
      if (now - evidence.observedAt < AGENT_AWAKE_FOREGROUND_AGENT_TTL_MS) {
        continue
      }
      // Why: renew from the runtime's live cache (never a scan); anything the
      // cache no longer confirms expires with the TTL.
      if (this.revalidate?.(ptyId) === true) {
        evidence.observedAt = now
      } else {
        this.evidenceByPtyId.delete(ptyId)
      }
    }
    return this.evidenceByPtyId.size
  }

  /** Earliest upcoming expiry among live evidence, or null when none. */
  nextExpiry(staleAfterMs: number): number | null {
    const now = this.now()
    let earliest: number | null = null
    for (const evidence of this.evidenceByPtyId.values()) {
      // Why: the TTL expiry drives revalidation; the 2h cap is the backstop.
      const expiry = Math.min(
        evidence.observedAt + AGENT_AWAKE_FOREGROUND_AGENT_TTL_MS,
        evidence.reportedAt + staleAfterMs
      )
      if (expiry <= now) {
        continue
      }
      earliest = earliest === null ? expiry : Math.min(earliest, expiry)
    }
    return earliest
  }
}
