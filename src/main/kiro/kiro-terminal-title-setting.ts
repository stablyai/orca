import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const KIRO_TERMINAL_TITLE_SETTING = 'chat.terminalTitle'

export function getKiroCliSettingsPath(): string {
  return join(homedir(), '.kiro', 'settings', 'cli.json')
}

/**
 * Turn on Kiro's OSC title.
 *
 * Why Orca writes this: `chat.terminalTitle` defaults to false, and that title
 * (`kiro: <session>`) is the only thing Kiro emits that identifies the pane as
 * its own — without it a Kiro pane is an anonymous terminal in the sidebar.
 * Kiro's built-in default agent has no config file to attach status hooks to,
 * so the title is the whole identity signal, not a nicety.
 *
 * Narrow on purpose: one key, only when unset, and every other key in the file
 * is preserved — a user who turns it back off is not overridden on next launch.
 */
export function enableKiroTerminalTitle(
  settingsPath: string = getKiroCliSettingsPath()
): 'enabled' | 'already-set' | 'failed' {
  try {
    let settings: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        // An unreadable shape is the user's file, not ours to replace.
        return 'failed'
      }
      settings = parsed as Record<string, unknown>
    }
    if (KIRO_TERMINAL_TITLE_SETTING in settings) {
      return 'already-set'
    }
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...settings, [KIRO_TERMINAL_TITLE_SETTING]: true }, null, 2)}\n`,
      'utf-8'
    )
    return 'enabled'
  } catch {
    return 'failed'
  }
}
