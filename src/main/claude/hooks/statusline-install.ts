import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeManagedScript } from '../../agent-hooks/installation/scripts/managed-hook-script-write'
import {
  refreshManagedScriptIfPresent,
  restoreManagedScript
} from '../../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { getSharedManagedScriptPath } from '../../agent-hooks/installation/scripts/managed-hook-script-path'
import type { HooksConfig } from '../../agent-hooks/installation/configuration/hook-config-schema'
import { getManagedStatusLineCommand, getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedStatusLine,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import { WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT } from './windows-statusline-stdin-reader'

const STATUSLINE_STDIN_READER_FILE_NAME = 'claude-statusline-read.cjs'

/** The bounded stdin reader the .cmd calls sits beside it in the shared agent-hooks dir. */
export function getStatusLineStdinReaderPath(): string {
  return getSharedManagedScriptPath(STATUSLINE_STDIN_READER_FILE_NAME)
}

/** Refresh the statusline .cmd and, on Windows, pair it with its bounded stdin reader. */
export async function refreshClaudeStatusLineScripts(
  settings: ClaudeCompatibleHookSettings
): Promise<boolean> {
  const refreshed = await refreshManagedScriptIfPresent(
    getStatusLineScriptPath(settings),
    getManagedStatusLineScript('local')
  )
  if (refreshed && process.platform === 'win32') {
    await restoreManagedScript(
      getStatusLineStdinReaderPath(),
      WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT
    )
  }
  return refreshed
}

// The marker distinguishes a user-deleted statusline from a first install.
export function installClaudeManagedStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): HooksConfig {
  const scriptFileName = getStatusLineScriptFileName(settings)
  const markerPath = getStatusLineInstallMarkerPath(settings)
  const slot = getStatusLineSlotState(config, scriptFileName)
  if (slot === 'user' || (slot === 'empty' && existsSync(markerPath))) {
    return config
  }
  const scriptPath = getStatusLineScriptPath(settings)
  writeManagedScript(scriptPath, getManagedStatusLineScript('local'))
  if (process.platform === 'win32') {
    writeManagedScript(
      join(dirname(scriptPath), STATUSLINE_STDIN_READER_FILE_NAME),
      WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT
    )
  }
  const next = applyManagedStatusLine(
    config,
    getManagedStatusLineCommand(scriptPath),
    scriptFileName
  )
  try {
    writeFileSync(markerPath, '')
  } catch {
    // Marker failure may cause a later user deletion to be reinstalled.
  }
  return next
}

// Older CLIs reject statusLine; clear the marker so an upgrade can reinstall it.
export function retireClaudeManagedStatusLine(
  config: HooksConfig,
  settings: ClaudeCompatibleHookSettings
): HooksConfig {
  const { config: next, changed } = removeManagedStatusLine(
    config,
    getStatusLineScriptFileName(settings)
  )
  if (changed) {
    try {
      rmSync(getStatusLineInstallMarkerPath(settings), { force: true })
    } catch {
      // A stale marker can suppress reinstall after an upgrade.
    }
  }
  return next
}
