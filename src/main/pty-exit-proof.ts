/**
 * What retiring a PTY rests on. Retiring its ownership, its lease or its runtime record drops the
 * only handle a later stop could use, so every retirement declares its evidence: a `PtyExitProof`
 * naming what the owning host observed, or a `PtyRetirementWithoutProof` carrying the
 * `unverifiable` reason. A declaration for review, not a capability: what keeps it honest is
 * config/scripts/check-unproven-pty-retirement-ratchet.mjs, which counts every unproven
 * retirement and every ownership drop that names no evidence.
 */
export type PtyExitProofSource =
  /** The owning provider emitted this incarnation's exit, or the legacy relay reported it. */
  | 'exit-observed'
  /** The owning provider's own inventory lacks it, or it answered "Session not found". */
  | 'absent'
  /** The owning provider completed the shutdown it was asked for. */
  | 'shutdown-acknowledged'
  /** A host-wide census answered `exited` for it. */
  | 'host-census'
  /** A stop-and-wait confirmed it: an observed exit, or absence from the owning inventory. */
  | 'stop-confirmed'

export class PtyExitProof {
  private constructor(
    readonly source: PtyExitProofSource,
    readonly incarnationId: string | undefined
  ) {}

  /** `incarnationId` is the one the evidence was about (`undefined` only for records that carry
   *  none, like relay leases): a same-id respawn must not inherit it. */
  static from(source: PtyExitProofSource, incarnationId: string | undefined): PtyExitProof {
    return new PtyExitProof(source, incarnationId)
  }
}

export class PtyRetirementWithoutProof {
  private constructor(readonly unverifiableReason: string) {}

  /** RATCHET: each call site is counted; a closed tab whose host can't answer still retires. */
  static because(unverifiableReason: string): PtyRetirementWithoutProof {
    return new PtyRetirementWithoutProof(unverifiableReason)
  }
}

export type PtyRetirementEvidence = PtyExitProof | PtyRetirementWithoutProof
