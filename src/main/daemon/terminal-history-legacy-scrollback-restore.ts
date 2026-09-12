import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { SessionMeta } from './history-manager'
import type { ColdRestoreInfo } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { readTerminalHistoryTextAsync } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES } from './terminal-history-file-limits'

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

// Why: handles the upgrade transition where sessions created before the
// checkpoint migration still have scrollback.bin but no checkpoint.json.
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

// Why: raw scrollback from TUI sessions (vim, less, htop) contains
// alternate-screen switches that produce garbled output when replayed.
// Truncate before the outermost unmatched alt-screen-on so only normal
// terminal output is restored.
function truncateAltScreen(data: string): string {
  let depth = 0
  let outermostUnmatchedOnIdx = -1

  let searchFrom = 0
  while (searchFrom < data.length) {
    const onIdx = data.indexOf(ALT_SCREEN_ON, searchFrom)
    const offIdx = data.indexOf(ALT_SCREEN_OFF, searchFrom)

    if (onIdx === -1 && offIdx === -1) {
      break
    }

    if (onIdx !== -1 && (offIdx === -1 || onIdx < offIdx)) {
      if (depth === 0) {
        outermostUnmatchedOnIdx = onIdx
      }
      depth++
      searchFrom = onIdx + ALT_SCREEN_ON.length
    } else {
      if (depth > 0) {
        depth--
      }
      searchFrom = offIdx + ALT_SCREEN_OFF.length
    }
  }

  if (depth > 0 && outermostUnmatchedOnIdx !== -1) {
    return data.slice(0, outermostUnmatchedOnIdx)
  }

  return data
}
