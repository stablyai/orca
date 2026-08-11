import type { TerminalModes } from './types'

export function splitTerminalSnapshotAnsi(
  snapshotAnsi: string,
  modes: TerminalModes
): { snapshotAnsi: string; scrollbackAnsi: string } {
  if (!modes.alternateScreen) {
    return { snapshotAnsi, scrollbackAnsi: '' }
  }
  const alternateScreenMarker = '\x1b[?1049h'
  const start = snapshotAnsi.lastIndexOf(alternateScreenMarker)
  if (start === -1) {
    return { snapshotAnsi, scrollbackAnsi: '' }
  }
  // Why: rehydrateSequences owns the alt-screen transition. Keeping the
  // normal buffer separate lets an already-alt renderer rebuild it safely.
  return {
    scrollbackAnsi: snapshotAnsi.slice(0, start),
    snapshotAnsi: snapshotAnsi.slice(start + alternateScreenMarker.length)
  }
}
