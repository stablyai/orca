import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalModes } from './terminal-modes'
import type { TerminalOwner } from '../../shared/terminal-owner'

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
