import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import { COLD_RESTORE_SEED_MODE_RESET } from '../../shared/terminal-mode-reset-profiles'

// Why the reset belongs in the seed and not only at replay: the recovered stream
// re-arms mouse reporting from two independent sources (rehydrateSequences AND
// SerializeAddon's own mode trailer inside snapshotAnsi), and the seed is what
// feeds the daemon's emulator — so without it every downstream consumer that
// re-serializes from that emulator, including mobile, inherits the dead TUI's
// modes no matter which profile the desktop renderer applies. See
// COLD_RESTORE_SEED_MODE_RESET for the precondition and the choice of bits.

export function getRecoveredHistorySeedSegments(restoreInfo: ColdRestoreInfo): readonly string[] {
  if (restoreInfo.modes.alternateScreen) {
    const normalBuffer = restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi
    return normalBuffer ? [normalBuffer, COLD_RESTORE_SEED_MODE_RESET] : []
  }
  const recovered = [restoreInfo.rehydrateSequences, restoreInfo.snapshotAnsi].filter(
    (segment) => segment.length > 0
  )
  const escapeTail = restoreInfo.pendingEscapeTailAnsi
  // Why: an empty list is daemon-pty-adapter's "nothing to recover" sentinel (it gates
  // the probe-race respawn and the history re-anchor), so the reset must never pad it.
  if (recovered.length === 0 && !escapeTail) {
    return []
  }
  // Why after the snapshot: it must undo the snapshot's own mode trailer, and
  // pendingEscapeTailAnsi is a torn escape that has to stay at the very end.
  return [...recovered, COLD_RESTORE_SEED_MODE_RESET, ...(escapeTail ? [escapeTail] : [])]
}
