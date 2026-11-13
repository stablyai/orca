import type { TerminalOwner } from '../../../../shared/terminal/pty/lifecycle/terminal-owner'
import type { TerminalJournalCwdNote } from './terminal-session-journal-contract'
import type {
  FlushHistoryUnavailableReason,
  TerminalHistoryCwdNoteOutcome
} from '../../protocol/daemon-history-protocol'

export type TerminalJournalOperationKind = 'commit' | 'sleep'

/** The admitted cut C: immutable once the operation exists. */
export type TerminalJournalAdmittedCut = {
  record: number
  appliedRevision: number
  outputSequence: number
  terminalOwner: TerminalOwner | undefined
}

/** A committed backing position: one log generation's complete-frame prefix. */
export type TerminalJournalPosition = { generation: number; logBytes: number }

/** The physically final cut F: every applied record through exit, with its settled qualifiers. */
export type TerminalJournalFinalCut = {
  record: number
  outputSequence: number
  settled: Promise<{ terminalOwner: TerminalOwner | undefined }>
}

export type TerminalJournalFinalReceipt = TerminalJournalPosition & {
  appliedRevision: number
  outputSequence: number
  backing: 'checkpoint' | 'raw'
}

export type TerminalJournalOperationFailure = {
  phase: 'preflight' | 'authorized' | 'exited'
  reason: FlushHistoryUnavailableReason
}

/**
 * The one commit or Sleep a journal admits at a time. Its C publication and its final outcome
 * are separate phases; the slot frees only at a terminal state, never when a waiter leaves.
 */
export class TerminalJournalOperation {
  readonly publication = Promise.withResolvers<TerminalJournalPosition | null>()
  readonly outcome = Promise.withResolvers<
    TerminalJournalFinalReceipt | TerminalJournalOperationFailure
  >()
  state: 'admitted' | 'published' | 'authorized' | 'final' | 'done' = 'admitted'
  failure: TerminalJournalOperationFailure | null = null
  /** Set when a pre-authorization waiter leaves: this operation can never kill. */
  killDisabled = false
  finalCut: TerminalJournalFinalCut | null = null
  /** The journal-owned Sleep preflight; it ends the operation if its waiter has left. */
  preflight: Promise<boolean> | null = null
  readonly cancel = new AbortController()
  /** The note this operation installed at C, and the effective note it replaced. */
  note: TerminalJournalCwdNote | null = null
  previousNote: TerminalJournalCwdNote | null = null

  constructor(
    readonly kind: TerminalJournalOperationKind,
    readonly incarnationId: string,
    /** A qualified literal probe, applied at C for a commit and at F for a Sleep. */
    readonly observation: string | null,
    readonly cut: TerminalJournalAdmittedCut,
    public cwdNote: TerminalHistoryCwdNoteOutcome
  ) {}
}
