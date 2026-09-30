import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import {
  PROCESS_BOUNDARY_GROUND,
  RESET_GRAPHIC_RENDITION
} from '../../shared/terminal-mode-reset-profiles'

// Why the ground belongs in the seed and not only at replay: the recovered stream
// re-arms input modes from two independent sources (rehydrateSequences AND
// SerializeAddon's own mode trailer inside snapshotAnsi), and the seed is what
// feeds the daemon's emulator — so without it every downstream consumer that
// re-serializes from that emulator, including mobile, inherits the dead process's
// modes no matter which profile the desktop renderer applies.

export function getRecoveredHistorySeedSegments(restoreInfo: ColdRestoreInfo): readonly string[] {
  if (restoreInfo.modes.alternateScreen) {
    const normalBuffer = restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi
    return normalBuffer
      ? [`${RESET_GRAPHIC_RENDITION}${normalBuffer}`, PROCESS_BOUNDARY_GROUND]
      : []
  }
  const recovered = [restoreInfo.rehydrateSequences, restoreInfo.snapshotAnsi].filter(
    (segment) => segment.length > 0
  )
  // Why: an empty list is daemon-pty-adapter's "nothing to recover" sentinel (it gates
  // the probe-race respawn and the history re-anchor), so the ground must never pad it.
  if (recovered.length === 0) {
    return []
  }
  // Why no pendingEscapeTailAnsi: every seed starts a new process, whose first bytes
  // must not complete an escape the dead one left half-written.
  const [firstRecovered, ...remainingRecovered] = recovered
  return [
    `${RESET_GRAPHIC_RENDITION}${firstRecovered}`,
    ...remainingRecovered,
    PROCESS_BOUNDARY_GROUND
  ]
}
