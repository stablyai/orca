import os from 'node:os'
import { join } from 'node:path'

/** Where a Cursor credential was found. */
export type CursorAuthSource = 'keychain' | 'cli' | 'desktop'

function cursorConfigRoot(source: Exclude<CursorAuthSource, 'keychain'>): string {
  if (process.platform === 'darwin') {
    return source === 'desktop'
      ? join(os.homedir(), 'Library', 'Application Support', 'Cursor')
      : join(os.homedir(), '.cursor')
  }
  if (process.platform === 'win32') {
    const root = process.env.APPDATA?.trim() || join(os.homedir(), 'AppData', 'Roaming')
    return join(root, 'Cursor')
  }
  const root = process.env.XDG_CONFIG_HOME?.trim() || join(os.homedir(), '.config')
  return join(root, source === 'desktop' ? 'Cursor' : 'cursor')
}

/** Cursor IDE global storage; holds `cursorAuth/*` keys in an `ItemTable` row. */
export function getCursorDesktopStateDbPath(): string {
  return join(cursorConfigRoot('desktop'), 'User', 'globalStorage', 'state.vscdb')
}

/** Pre-2026.06 `cursor-agent` token file; newer CLIs keep the token in the OS keychain. */
export function getCursorCliAuthPath(): string {
  return join(cursorConfigRoot('cli'), 'auth.json')
}

/** `cursor-agent` settings file; its `authInfo` block carries the signed-in identity, never a token. */
export function getCursorCliConfigPath(): string {
  return join(cursorConfigRoot('cli'), 'cli-config.json')
}
