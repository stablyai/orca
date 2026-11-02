import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SessionMeta } from './history-manager'
import type { ColdRestoreInfo } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { readTerminalHistoryTextAsync } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES } from './terminal-history-file-limits'

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

// Sessions predating checkpoints may have only scrollback.bin.
export async function detectColdRestoreFromLegacyScrollback(
  basePath: string,
  sessionId: string,
  meta: SessionMeta
): Promise<ColdRestoreInfo | null> {
  const scrollbackPath = join(basePath, getHistorySessionDirName(sessionId), 'scrollback.bin')
  if (!existsSync(scrollbackPath)) {
    return null
  }
  try {
    const scrollback = await readTerminalHistoryTextAsync(
      scrollbackPath,
      TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES
    )
    const truncated = truncateAltScreen(scrollback)
    return {
      snapshotAnsi: truncated,
      scrollbackAnsi: truncated,
      rehydrateSequences: '',
      cwd: meta.cwd,
      cols: meta.cols,
      rows: meta.rows,
      modes: {
        bracketedPaste: false,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: false
      }
    }
  } catch {
    return null
  }
}

// Exclude an unfinished alternate-screen session to avoid replaying a partial TUI.
function truncateAltScreen(data: string): string {
  let depth = 0
  let outermostUnmatchedOnIdx = -1

  let onIdx = data.indexOf(ALT_SCREEN_ON)
  let offIdx = data.indexOf(ALT_SCREEN_OFF)
  while (onIdx !== -1 || offIdx !== -1) {
    if (onIdx !== -1 && (offIdx === -1 || onIdx < offIdx)) {
      if (depth === 0) {
        outermostUnmatchedOnIdx = onIdx
      }
      depth++
      onIdx = data.indexOf(ALT_SCREEN_ON, onIdx + ALT_SCREEN_ON.length)
    } else {
      if (depth > 0) {
        depth--
      }
      offIdx = data.indexOf(ALT_SCREEN_OFF, offIdx + ALT_SCREEN_OFF.length)
    }
  }

  if (depth > 0 && outermostUnmatchedOnIdx !== -1) {
    return data.slice(0, outermostUnmatchedOnIdx)
  }

  return data
}
