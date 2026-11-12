import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { TerminalSnapshot } from '../../protocol/terminal-snapshot'
import type { TerminalOwner } from '../../../../shared/terminal/pty/lifecycle/terminal-owner'
import type { TerminalSessionJournalReads } from './terminal-session-journal-reads'

export type TerminalSessionJournalHost = {
  acquireReplay(priority: number): Promise<() => void>
  charge(journal: TerminalSessionJournalReads, bytes: number): void
  settled(journal: TerminalSessionJournalReads): void
  log(event: string, details: Record<string, unknown>): void
}

/** An immutable applied cut: committed log prefix plus the uncommitted records at that moment. */
export type TerminalHistoryCut = {
  generation: number
  logBytes: number
  records: PendingOutputRecord[]
  outputSequence: number
  terminalOwner: TerminalOwner | undefined
  gapped: boolean
}

export type TerminalJournalSession = {
  readonly incarnationId: string
  readonly historySeeded: boolean | undefined
  readonly isAlive: boolean
  settleShellOwnershipConfirmation(): Promise<void>
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
