// Why: foreground-agent scans are event-driven (title status transitions,
// session listing sweeps), not periodic. The TTL only bridges gaps between
// them; expiry revalidates against the runtime's cached foreground state
// instead of forcing a new process scan.
export const AGENT_AWAKE_FOREGROUND_AGENT_TTL_MS = 5 * 60 * 1000

type ForegroundAgentEvidence = {
  // Last time a real scan reported this PTY's recognized foreground agent.
  reportedAt: number
  // Refreshed by scans AND by cache revalidation at TTL expiry.
  observedAt: number
}

/**
 * Per-PTY keep-awake evidence for recognized foreground agents (wrapper
 * claude etc.) that emit no hook statuses. Only recognized agents are ever
 * reported here — arbitrary processes never grant wake eligibility.
 */
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
    this.evidenceByPtyId.set(ptyId, { reportedAt: now, observedAt: now })
    return true
  }

  /** Drops expired evidence; counts what remains toward wake eligibility. */
  pruneAndCount(staleAfterMs: number): number {
    const now = this.now()
    for (const [ptyId, evidence] of this.evidenceByPtyId) {
      if (now - evidence.observedAt <= AGENT_AWAKE_FOREGROUND_AGENT_TTL_MS) {
        continue
      }
      // Why: renew from the runtime's live cache (never a scan), hard-capped by
      // the same 2h window hook statuses get so a stale cache cannot block
      // sleep indefinitely. Anything else expires with the TTL.
      if (now - evidence.reportedAt <= staleAfterMs && this.revalidate?.(ptyId) === true) {
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
