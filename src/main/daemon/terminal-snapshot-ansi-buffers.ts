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
  // Why: rehydrateSequences owns the alt-screen transition. Keeping the
  // normal buffer separate lets an already-alt renderer rebuild it safely.
  return { scrollbackAnsi: split.normalAnsi, snapshotAnsi: split.alternateAnsi }
}
