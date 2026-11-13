import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import type { TerminalOwner } from '../../../../shared/terminal/pty/lifecycle/terminal-owner'
import type { TerminalSessionJournalReads } from './terminal-session-journal-reads'
import type { DerivedHistoryImageBudget } from './terminal-history-derived-image'
import type { RevocablePendingSource } from './terminal-history-pending-source'

export type TerminalSessionJournalHost = {
  acquireReplay(priority: number, signal?: AbortSignal): Promise<() => void>
  readonly images: DerivedHistoryImageBudget
  charge(journal: TerminalSessionJournalReads, bytes: number): void
  /** Before a write of this many bytes: frees reader-held backing if the host total needs it. */
  makeRoom(bytes: number): void
  settled(journal: TerminalSessionJournalReads): void
  log(event: string, details: Record<string, unknown>): void
  /** Whether this journal is still its ID's directory owner; checked before every note/origin write. */
  owns(journal: TerminalSessionJournalReads): boolean
}

/**
 * The journal's latest effective probed folder: still at its absolute record boundary, or
 * published at a committed position of one log generation.
 */
export type TerminalJournalCwdNote =
  | { cwd: string; record: number }
  | { cwd: string; generation: number; logBytes: number }

/** What physical exit hands the journal: the final stream position and the settled parser. */
export type TerminalJournalPhysicalFinal = {
  outputSequence: number
  /** Settles after every already-issued parser write, then reads the final owner. */
  settled: Promise<{ terminalOwner: TerminalOwner | undefined }>
}

/** An immutable applied cut: committed log prefix plus the uncommitted records at that moment. */
export type TerminalHistoryCut = {
  generation: number
  logBytes: number
  /** Absolute index of the first uncommitted record, where `records` begins. */
  firstRecord: number
  /** The folder note effective at this cut, captured with it. */
  cwdNote: TerminalJournalCwdNote | null
  records: PendingOutputRecord[]
  outputSequence: number
  terminalOwner: TerminalOwner | undefined
  gapped: boolean
}

/** A reader's immutable cut: scalars plus the handle that alone owns its frozen records. */
export type TerminalHistoryReadCut = Omit<TerminalHistoryCut, 'records'> & {
  source: RevocablePendingSource
}

export type TerminalJournalSession = {
  readonly incarnationId: string
  readonly historySeeded: boolean | undefined
  readonly isAlive: boolean
  /** A teardown already claimed the process. */
  readonly isTerminating?: boolean
  settleShellOwnershipConfirmation(): Promise<void>
  /** Releases held startup bytes into the stream, as a live snapshot would first. */
  snapshotBarrier(): void
  prepareForFinalSnapshot(): string
}

/** The live output plane's view at a cut; bound once when the plane is built. */
export type TerminalJournalOutput = {
  outputSequence(): number
  terminalOwner(): TerminalOwner | undefined
  hasAttachedClient(token: symbol): boolean
}

export type TerminalHistoryImage = {
  snapshot: TerminalSnapshot
  outcome: { kind: 'origin' | 'fold'; incarnationId: string; outputSequence: number }
}
