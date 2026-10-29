import type { TerminalModes } from './types'
import { splitAtAlternateScreenEntry } from '../../shared/terminal-alternate-screen-split'

export function splitTerminalSnapshotAnsi(
  snapshotAnsi: string,
  modes: TerminalModes
): { snapshotAnsi: string; scrollbackAnsi: string } {
  const split = modes.alternateScreen ? splitAtAlternateScreenEntry(snapshotAnsi) : null
  if (!split) {
    return { snapshotAnsi, scrollbackAnsi: '' }
  }
  // Keep normal-buffer replay separate; rehydrateSequences owns the alternate-screen transition.
  return { scrollbackAnsi: split.normalAnsi, snapshotAnsi: split.alternateAnsi }
}
