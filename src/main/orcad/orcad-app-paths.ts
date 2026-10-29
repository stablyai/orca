// Return real Node-host paths or throw: plausible catch-all directories can be forked as executables.
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import type { AppPathName } from '../../shared/app-environment'

// Empty exported paths remain unset.
function env(name: string): string | null {
  const value = process.env[name]
  return value ? value : null
}

export function resolveUserDataPath(): string {
  const explicit = env('ORCA_USER_DATA')
  if (explicit) {
    return explicit
  }
  const xdg = env('XDG_DATA_HOME')
  return xdg ? join(xdg, 'Orca') : join(homedir(), '.orca')
}

function resolveAppDataPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return env('APPDATA') ?? join(homedir(), 'AppData', 'Roaming')
  }
  return env('XDG_CONFIG_HOME') ?? join(homedir(), '.config')
}

/** Resolve bundle siblings beside the real entry script; cwd and symlink locations can be unrelated. */
export function resolveOrcadInstallRoot(scriptPath = process.argv[1]): string {
  if (!scriptPath) {
    throw new Error(
      'orcad_install_root_unavailable — process.argv[1] is unset, so this process has no ' +
        'bundle root to resolve sibling entry points against'
    )
  }
  const absolute = resolve(scriptPath)
  let script = absolute
  try {
    script = realpathSync(absolute)
  } catch {
    // Missing scripts still establish a directory; sibling lookups diagnose missing resources.
  }
  return dirname(script)
}

export function resolveOrcadPath(name: AppPathName): string {
  switch (name) {
    case 'userData':
      return resolveUserDataPath()
    case 'home':
      return homedir()
    case 'temp':
      return tmpdir()
    case 'appData':
      return resolveAppDataPath()
    // Keep headless state in one removable userData tree; service accounts may lack macOS Library.
    case 'logs':
      return join(resolveUserDataPath(), 'logs')
    case 'exe':
      return process.execPath
    case 'downloads':
      return env('XDG_DOWNLOAD_DIR') ?? join(homedir(), 'Downloads')
  }
}
