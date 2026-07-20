import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalModes } from './terminal-modes'

export type TerminalSnapshot = {
  snapshotAnsi: string
  /** Parser tail is already counted by the snapshot sequence and must restore last. */
  pendingEscapeTailAnsi?: string
  /** Normal buffer captured separately while snapshotAnsi holds an alternate buffer. */
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cwd: string | null
  modes: TerminalModes
  cols: number
  rows: number
  scrollbackLines: number
  lastTitle?: string
  /** Optional because persisted snapshots and older v19 daemons lack it. */
  outputSequence?: number
}
