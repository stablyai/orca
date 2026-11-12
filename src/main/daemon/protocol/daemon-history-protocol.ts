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
  /** final seals the incarnation: Sleep's verified capture, after which exit is never clean. */
  payload: { sessionId: string; expectedIncarnationId?: string; final?: boolean }
}

export type FlushHistoryResult = { status: 'committed' | 'unavailable' }

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
