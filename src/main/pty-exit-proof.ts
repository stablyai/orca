// Retiring ownership drops the handle needed to stop a PTY; declare exit evidence or an unverifiable reason.
// check-unproven-pty-retirement-ratchet.mjs counts unproven retirements and missing evidence.
export type PtyExitProofSource =
  /** The owning provider emitted this incarnation's exit, or the legacy relay reported it. */
  | 'exit-observed'
  /** The owning provider's own inventory lacks it, or it answered "Session not found". */
  | 'absent'
  | 'shutdown-acknowledged'
  | 'host-census'
  /** A stop-and-wait confirmed it: an observed exit, or absence from the owning inventory. */
  | 'stop-confirmed'

export class PtyExitProof {
  private constructor(
    readonly source: PtyExitProofSource,
    readonly incarnationId: string | undefined
  ) {}

  /** Bind proof to its observed incarnation; legacy records without incarnation IDs pass undefined. */
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
