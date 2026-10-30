import type { ColdRestoreInfo } from './terminal-history-cold-restore-info'
import {
  PROCESS_BOUNDARY_GROUND,
  RESET_GRAPHIC_RENDITION
} from '../../shared/terminal-mode-reset-profiles'
import { buildFreshShellViewportBlankingSequence } from '../../shared/terminal-fresh-shell-viewport'

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

// Why: the window blanks its viewport after painting a restore, but the daemon's seeded screen
// did not, so a reattach showed the new shell's prompt beside the old one (`$ $`).
function freshShellViewport(restoreInfo: ColdRestoreInfo): string {
  return buildFreshShellViewportBlankingSequence(restoreInfo.rows)
}
