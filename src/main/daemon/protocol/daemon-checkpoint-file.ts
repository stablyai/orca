import type { TerminalOscLinkRange } from '../../../shared/terminal/links/terminal-osc-link-ranges'
import type { TerminalModes } from './terminal-modes'
import type { TerminalOwner } from '../../../shared/terminal/pty/lifecycle/terminal-owner'

/** Shared checkpoint.json shape; generation pairs it with the matching output.log header. */
export type TerminalCheckpointFile = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  pendingEscapeTailAnsi?: string
  cwd: string | null
  cols: number
  rows: number
  modes: TerminalModes
  scrollbackLines: number
  lastTitle?: string
  terminalOwner?: TerminalOwner
  /** Matches output.log generation; absent on checkpoints predating incremental logs. */
  generation?: number
  /** Last daemon pending-output batch included in this checkpoint. */
  pendingOutputSeq?: number
  checkpointedAt: string
}
