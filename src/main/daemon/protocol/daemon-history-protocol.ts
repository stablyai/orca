import type { PtyIncarnationId } from '../../../shared/terminal/pty/lifecycle/pty-incarnation'

/**
 * Coverage of a host-owned history read at its applied cut. origin: since the incarnation began;
 * fold: since a retained-window fold (pre-fold parser modes may be lost); gap: only the live
 * window is proven after a storage gap; unavailable: no image. Row counts never prove coverage.
 */
export type TerminalHistoryOutcome =
  | {
      kind: 'origin' | 'fold' | 'gap'
      incarnationId: PtyIncarnationId
      outputSequence: number
    }
  | { kind: 'unavailable'; incarnationId?: PtyIncarnationId }

export type FlushHistoryRequest = {
  id: string
  type: 'flushHistory'
  payload: {
    sessionId: string
    /** commit makes the cut durable and leaves the terminal running; sleep also ends it. */
    intent: 'commit' | 'sleep'
    expectedIncarnationId: string
    /** A successful literal folder probe; ordered at C for commit, at the final cut for sleep. */
    cwdObservation?: { cwd: string }
    /** Sleep only: the caller's existing immediate-versus-graceful kill intent. */
    immediate?: boolean
    remainingBudgetMs?: number
  }
}

/** What happened to the probed folder: rejected means a malformed probe was not saved. */
export type TerminalHistoryCwdNoteOutcome = 'none' | 'published' | 'folded' | 'rejected'

export type FlushHistoryUnavailableReason =
  | 'absent'
  | 'busy'
  | 'terminating'
  | 'exited'
  | 'refused'
  | 'gap'
  | 'unreadable'
  | 'unrepresentable'
  | 'canceled'
  | 'deadline'
  | 'write_failed'

type FlushHistoryReceipt = {
  incarnationId: string
  appliedRevision: number
  outputSequence: number
  generation: number
  logBytes: number
  cwdNote: TerminalHistoryCwdNoteOutcome
}

/**
 * committed: the cut is durable and the terminal still runs. finalized: the process physically
 * exited and its final history is verified. unavailable: preflight never authorized termination;
 * authorized means termination was accepted but exit or publication is unproven; exited means
 * the process ended and only its readable prefix remains.
 */
export type FlushHistoryResult =
  | ({ status: 'committed' } & FlushHistoryReceipt)
  | ({ status: 'finalized'; backing: 'checkpoint' | 'raw' } & FlushHistoryReceipt)
  | {
      status: 'unavailable'
      incarnationId?: string
      phase: 'preflight' | 'authorized' | 'exited'
      reason: FlushHistoryUnavailableReason
    }

export const TERMINAL_HISTORY_UNAVAILABLE = 'terminal_history_unavailable'

/** Recoverable: the same ID can retry; never proof that the terminal is gone. */
export class TerminalHistoryUnavailableError extends Error {
  constructor() {
    super(TERMINAL_HISTORY_UNAVAILABLE)
    this.name = 'TerminalHistoryUnavailableError'
  }
}

export function isTerminalHistoryUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TERMINAL_HISTORY_UNAVAILABLE)
}
