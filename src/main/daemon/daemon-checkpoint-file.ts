import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TerminalModes } from './types'

/** On-disk shape of checkpoint.json. Written by history-manager, read by
 *  history-reader — one type so the generation pairing with output.log's
 *  header (see terminal-history-log.ts) cannot silently diverge between the
 *  writer and the consumer. */
export type TerminalCheckpointFile = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cwd: string | null
  cols: number
  rows: number
  modes: TerminalModes
  scrollbackLines: number
  /** Ties this checkpoint to the output.log whose header carries the same
   *  generation. Absent on checkpoints written before incremental logs. */
  generation?: number
  checkpointedAt: string
}
