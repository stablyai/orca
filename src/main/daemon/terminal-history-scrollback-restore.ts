import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from './history-manager'
import { getHistorySessionDirName } from './history-paths'
import { truncateUnclosedAlternateScreen } from './terminal-alt-screen-truncation'
import { readTerminalHistoryText } from './terminal-history-file-reader'
import { TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES } from './terminal-history-file-limits'
import type { ColdRestoreInfo } from './history-reader'

export function restoreTerminalHistoryScrollback(
  basePath: string,
  sessionId: string,
  meta: SessionMeta
): ColdRestoreInfo | null {
  const scrollbackPath = join(basePath, getHistorySessionDirName(sessionId), 'scrollback.bin')
  if (!existsSync(scrollbackPath)) {
    return null
  }
  try {
    const scrollback = readTerminalHistoryText(
      scrollbackPath,
      TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES
    )
    const truncated = truncateUnclosedAlternateScreen(scrollback)
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
