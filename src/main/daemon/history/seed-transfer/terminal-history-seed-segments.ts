import type { ColdRestoreInfo } from '../restoration/terminal-history-cold-restore-info'
import {
  PROCESS_BOUNDARY_GROUND,
  RESET_GRAPHIC_RENDITION
} from '../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { buildFreshShellViewportSequence } from '../../../../shared/terminal/viewport/terminal-fresh-shell-viewport'

// Reset modes after seeding the daemon too, or downstream snapshots (including mobile) re-arm dead TUI state.

export function getRecoveredHistorySeedSegments(restoreInfo: ColdRestoreInfo): readonly string[] {
  if (restoreInfo.modes.alternateScreen) {
    const normalBuffer = restoreInfo.scrollbackAnsi || restoreInfo.snapshotAnsi
    return normalBuffer
      ? [
          `${RESET_GRAPHIC_RENDITION}${normalBuffer}`,
          PROCESS_BOUNDARY_GROUND,
          freshShellViewport(restoreInfo)
        ]
      : []
  }
  const recovered = [restoreInfo.rehydrateSequences, restoreInfo.snapshotAnsi].filter(
    (segment) => segment.length > 0
  )
  // Preserve the empty sentinel used to gate respawn and history re-anchoring.
  if (recovered.length === 0) {
    return []
  }
  // A new process must not complete an escape sequence left by its predecessor.
  const [firstRecovered, ...remainingRecovered] = recovered
  return [
    `${RESET_GRAPHIC_RENDITION}${firstRecovered}`,
    ...remainingRecovered,
    PROCESS_BOUNDARY_GROUND,
    freshShellViewport(restoreInfo)
  ]
}

// Why: match the window's fresh-shell start, or a reattach shows the new prompt beside the old one (`$ $`).
// This runs on the PTY's own host, so its platform names the PTY backend.
function freshShellViewport(restoreInfo: ColdRestoreInfo): string {
  return buildFreshShellViewportSequence(restoreInfo.rows, process.platform === 'win32')
}
