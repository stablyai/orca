import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  TERMINAL_ORDERED_INPUT_MAX_BYTES,
  TERMINAL_ORDERED_INPUT_MAX_WAITERS,
  TERMINAL_ORDERED_INPUT_HOST_MAX_BYTES,
  TERMINAL_ORDERED_INPUT_HOST_MAX_WAITERS,
  type TerminalInputSessionBinding
} from '../../../../../shared/terminal/input/terminal-ordered-input'

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
  strict?: {
    token: string
    binding: TerminalInputSessionBinding
    blocked: boolean
    pending: number
    bytes: number
    fingerprints: Map<number, string>
  }
}

/** Serialize Go-back-N input per PTY/client session across connection replacement; replay writes once even when dead-connection copies arrive late. */
export class TerminalInputSequenceLedger {
  // Publish a new ledger id after runtime restart so clients discard unknown input instead of replaying forgotten writes.
  readonly id = randomUUID()
  private readonly sessions = new Map<string, Session>()
  private readonly legacyPending = new Map<string, number>()
  private strictPending = 0
  private strictBytes = 0

  trackLegacy<T>(ptyId: string, owner: string, write: () => Promise<T>): Promise<T> {
    const key = this.strictKey(ptyId, owner)
    this.legacyPending.set(key, (this.legacyPending.get(key) ?? 0) + 1)
    return Promise.resolve()
      .then(write)
      .finally(() => {
        const remaining = (this.legacyPending.get(key) ?? 1) - 1
        if (remaining) {
          this.legacyPending.set(key, remaining)
        } else {
          this.legacyPending.delete(key)
        }
      })
  }

  hasPendingStrict(ptyId: string, owner: string): boolean {
    return (this.sessions.get(this.strictKey(ptyId, owner))?.strict?.pending ?? 0) > 0
  }

  openStrictSession(owner: string, binding: TerminalInputSessionBinding): string | null {
    const key = this.strictKey(binding.ptyId, owner)
    if (this.legacyPending.has(key) || this.sessions.get(key)?.strict?.pending) {
      return null
    }
    if (
      !this.sessions.has(key) &&
      this.sessions.size >= TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS
    ) {
      const idle = [...this.sessions].find(([, session]) => !session.strict?.pending)
      if (!idle) {
        return null
      }
      this.sessions.delete(idle[0])
    }
    const token = randomUUID()
    this.sessions.set(key, {
      appliedSeq: 0,
      tail: Promise.resolve(),
      unknownSeqs: new Set(),
      unknownForgottenThrough: 0,
      strict: { token, binding, blocked: false, pending: 0, bytes: 0, fingerprints: new Map() }
    })
    return token
  }

  isStrictSessionCurrent(ptyId: string, owner: string, token: string): boolean {
    const strict = this.sessions.get(this.strictKey(ptyId, owner))?.strict
    return strict?.token === token && !strict.blocked
  }

  admitStrict(
    ptyId: string,
    owner: string,
    token: string,
    seq: number,
    bytes: number,
    fingerprint: string,
    assertBinding: (binding: TerminalInputSessionBinding) => void,
    write: (binding: TerminalInputSessionBinding) => Promise<TerminalInputWriteOutcome>
  ): Promise<TerminalInputAdmission> {
    const key = this.strictKey(ptyId, owner)
    const session = this.sessions.get(key)
    const strict = session?.strict
    const refuse = () =>
      Promise.resolve<TerminalInputAdmission>({
        kind: 'resend',
        appliedSeq: session?.appliedSeq ?? 0
      })
    if (!session || !strict || strict.token !== token) {
      return refuse()
    }
    if (strict.blocked) {
      return strict.fingerprints.get(seq) === fingerprint && session.unknownSeqs.has(seq)
        ? Promise.resolve({ kind: 'delivery-unknown', appliedSeq: seq })
        : refuse()
    }
    try {
      assertBinding(strict.binding)
    } catch {
      strict.blocked = true
      return refuse()
    }
    const prior = strict.fingerprints.get(seq)
    if (
      this.legacyPending.has(key) ||
      (prior !== undefined && prior !== fingerprint) ||
      (seq <= session.appliedSeq && prior === undefined) ||
      strict.pending >= TERMINAL_ORDERED_INPUT_MAX_WAITERS ||
      this.strictPending >= TERMINAL_ORDERED_INPUT_HOST_MAX_WAITERS ||
      strict.bytes + bytes > TERMINAL_ORDERED_INPUT_MAX_BYTES ||
      this.strictBytes + bytes > TERMINAL_ORDERED_INPUT_HOST_MAX_BYTES
    ) {
      strict.blocked = true
      return refuse()
    }
    strict.fingerprints.set(seq, fingerprint)
    if (strict.fingerprints.size > TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_UNKNOWN_SEQS) {
      const oldest = strict.fingerprints.keys().next()
      if (!oldest.done) {
        strict.fingerprints.delete(oldest.value)
      }
    }
    strict.pending += 1
    strict.bytes += bytes
    this.strictPending += 1
    this.strictBytes += bytes
    this.sessions.delete(key)
    this.sessions.set(key, session)
    const run = session.tail
      .then(async (): Promise<TerminalInputAdmission> => {
        if (strict.blocked) {
          return { kind: 'resend', appliedSeq: session.appliedSeq }
        }
        if (seq <= session.appliedSeq) {
          return {
            kind: session.unknownSeqs.has(seq) ? 'delivery-unknown' : 'applied',
            appliedSeq: seq
          }
        }
        if (seq !== session.appliedSeq + 1) {
          strict.blocked = true
          return { kind: 'resend', appliedSeq: session.appliedSeq }
        }
        let outcome: TerminalInputWriteOutcome
        try {
          assertBinding(strict.binding)
          outcome = await write(strict.binding)
        } catch {
          outcome = 'delivery-unknown'
        }
        if (outcome !== 'applied') {
          strict.blocked = true
        }
        if (outcome === 'refused') {
          return { kind: 'resend', appliedSeq: session.appliedSeq }
        }
        session.appliedSeq = seq
        if (outcome === 'delivery-unknown') {
          rememberUnknown(session, seq)
        }
        return { kind: outcome, appliedSeq: seq }
      })
      .finally(() => {
        strict.pending -= 1
        strict.bytes -= bytes
        this.strictPending -= 1
        this.strictBytes -= bytes
      })
    session.tail = run.then(() => undefined)
    return run
  }

  private strictKey(ptyId: string, owner: string): string {
    return `strict\u0000${ptyId}\u0000${owner}`
  }

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
      const oldest = [...this.sessions].find(([, session]) => !session.strict?.pending)
      if (!oldest) {
        return
      }
      this.sessions.delete(oldest[0])
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
