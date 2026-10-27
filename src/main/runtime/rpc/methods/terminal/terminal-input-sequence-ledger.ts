import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'

// Bound per-PTY/client-session entries; evicted idle sessions have no pending acknowledgements.
export const TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS = 4096

/** Refused proves no write; delivery-unknown may have written and must never be blindly retried as a duplicate command. */
export type TerminalInputWriteOutcome = 'applied' | 'refused' | 'delivery-unknown'

/** Settle every sequence through appliedSeq; resend requests the remaining suffix in order after a refusal/gap. */
export type TerminalInputAdmission = {
  kind: 'applied' | 'delivery-unknown' | 'resend'
  appliedSeq: number
}

// Remember bounded unknown outcomes; duplicates older than that window also remain unknown.
export const TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_UNKNOWN_SEQS = 256

type Session = {
  appliedSeq: number
  tail: Promise<void>
  // Retain unknown results after ack because the connection may lose it; duplicates must not become applied.
  unknownSeqs: Set<number>
  unknownForgottenThrough: number
}

/** Serialize Go-back-N input per PTY/client session across connection replacement; replay writes once even when dead-connection copies arrive late. */
export class TerminalInputSequenceLedger {
  // Publish a new ledger id after runtime restart so clients discard unknown input instead of replaying forgotten writes.
  readonly id = randomUUID()
  private readonly sessions = new Map<string, Session>()

  admit(
    ptyId: string,
    inputSessionId: string,
    seq: number,
    write: () => Promise<TerminalInputWriteOutcome>
  ): Promise<TerminalInputAdmission> {
    const key = `${ptyId}\u0000${inputSessionId}`
    // Why a new session starts at any sequence: the client numbers input per pane, not per PTY.
    const session = this.sessions.get(key) ?? {
      appliedSeq: seq - 1,
      tail: Promise.resolve(),
      unknownSeqs: new Set<number>(),
      unknownForgottenThrough: seq - 1
    }
    this.sessions.delete(key)
    this.sessions.set(key, session)
    this.evictOverflow()
    const run = session.tail.then(async (): Promise<TerminalInputAdmission> => {
      if (seq <= session.appliedSeq) {
        // Why this seq, not the latest: the client settles each write from its own ack only.
        const unknown = session.unknownSeqs.has(seq) || seq <= session.unknownForgottenThrough
        return { kind: unknown ? 'delivery-unknown' : 'applied', appliedSeq: seq }
      }
      if (seq > session.appliedSeq + 1) {
        return { kind: 'resend', appliedSeq: session.appliedSeq }
      }
      const outcome = await write().catch((): TerminalInputWriteOutcome => 'delivery-unknown')
      if (outcome === 'refused') {
        return { kind: 'resend', appliedSeq: session.appliedSeq }
      }
      session.appliedSeq = seq
      if (outcome === 'delivery-unknown') {
        rememberUnknown(session, seq)
      }
      return { kind: outcome, appliedSeq: seq }
    })
    session.tail = run.then(() => undefined)
    return run
  }

  private evictOverflow(): void {
    while (this.sessions.size > TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) {
        return
      }
      this.sessions.delete(oldest.value)
    }
  }
}

function rememberUnknown(session: Session, seq: number): void {
  session.unknownSeqs.add(seq)
  if (session.unknownSeqs.size > TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_UNKNOWN_SEQS) {
    const oldest = session.unknownSeqs.values().next()
    if (!oldest.done) {
      session.unknownSeqs.delete(oldest.value)
      session.unknownForgottenThrough = oldest.value
    }
  }
}

const ledgers = new WeakMap<OrcaRuntimeService, TerminalInputSequenceLedger>()

export function getTerminalInputSequenceLedger(
  runtime: OrcaRuntimeService
): TerminalInputSequenceLedger {
  let ledger = ledgers.get(runtime)
  if (!ledger) {
    ledger = new TerminalInputSequenceLedger()
    ledgers.set(runtime, ledger)
  }
  return ledger
}
