import type { TerminalOscLinkRange } from '../../../shared/terminal/links/terminal-osc-link-ranges'
import type { TerminalModes } from './terminal-modes'
import type { TerminalOwner } from '../../../shared/terminal/pty/lifecycle/terminal-owner'
import type { RuntimeTerminalProjection } from '../../../shared/terminal/runtime/runtime-terminal-contracts'

export type TerminalSnapshotReadOptions = {
  scrollbackRows?: number
  visibleProjection?: true
}

export type TerminalSnapshot = {
  snapshotAnsi: string
  /** Parser tail is already counted by the snapshot sequence and must restore last. */
  pendingEscapeTailAnsi?: string
  /** Normal buffer captured separately while snapshotAnsi holds an alternate buffer. */
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  /** Live modes and cursor state that can be restored without the alt frame. */
  frameRestoreAnsi?: string
  cwd: string | null
  modes: TerminalModes
  cols: number
  rows: number
  scrollbackLines: number
  lastTitle?: string
  /** Optional because persisted snapshots and older v19 daemons lack it. */
  outputSequence?: number
  /** Ordered shell lifecycle evidence captured at this snapshot boundary. */
  terminalOwner?: TerminalOwner
}

export type TerminalVisibleProjectionSnapshot = Pick<
  TerminalSnapshot,
  'cols' | 'rows' | 'cwd' | 'modes' | 'lastTitle' | 'terminalOwner'
> & {
  visibleProjection: RuntimeTerminalProjection
  outputSequence: number
}
