import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { SessionMeta } from './terminal-history-metadata'
import type { TerminalModes } from './types'

export type ColdRestoreInfo = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cwd: string
  cols: number
  rows: number
  modes: TerminalModes
}

type RestoredSnapshot = {
  snapshotAnsi: string
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  cols: number
  rows: number
  modes: TerminalModes
}

export function coldRestoreInfoFromSnapshot(
  snapshot: RestoredSnapshot,
  cwd: string | null,
  meta: SessionMeta
): ColdRestoreInfo {
  // Why: legacy normal snapshots stored their buffer only in snapshotAnsi.
  const scrollbackAnsi =
    snapshot.scrollbackAnsi || (snapshot.modes?.alternateScreen ? '' : snapshot.snapshotAnsi)
  return {
    snapshotAnsi: snapshot.snapshotAnsi,
    scrollbackAnsi,
    oscLinks: snapshot.oscLinks,
    rehydrateSequences: snapshot.rehydrateSequences,
    cwd: cwd ?? meta.cwd,
    cols: snapshot.cols,
    rows: snapshot.rows,
    modes: snapshot.modes
  }
}
