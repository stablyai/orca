/**
 * The path half of orcad's `AppEnvironment`: every `AppPathName` gets a real answer for
 * a Node host, or throws.
 *
 * Why not a catch-all: returning the data directory for names this host had not thought
 * about — `'exe'` above all — hands the caller a plausible string it then forks, installs
 * beside, or resolves resources against. The failure surfaces far from here, as a missing
 * file rather than a missing implementation.
 */
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import type { AppPathName } from '../../shared/app-environment'

/** Empty is unset: a supervisor that exports `APPDATA=` has configured nothing. */
function env(name: string): string | null {
  const value = process.env[name]
  return value ? value : null
}

/** XDG-ish data root. `$ORCA_USER_DATA` wins so a smoke test can isolate state. */
export function resolveUserDataPath(): string {
  const explicit = env('ORCA_USER_DATA')
  if (explicit) {
    return explicit
  }
  const xdg = env('XDG_DATA_HOME')
  return xdg ? join(xdg, 'Orca') : join(homedir(), '.orca')
}

/** Electron's `'appData'` definition, computed without Electron. */
function resolveAppDataPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support')
  }
  if (process.platform === 'win32') {
    return env('APPDATA') ?? join(homedir(), 'AppData', 'Roaming')
  }
  return env('XDG_CONFIG_HOME') ?? join(homedir(), '.config')
}

/**
 * The directory orcad was launched from — the bundle root that `orcad.js` and the
 * children shipped beside it (the watcher entry, the agent-browser binary) live in.
 *
 * Why argv[1] and not cwd: cwd is wherever the operator or supervisor happened to be,
 * so resolving siblings against it finds them only by luck. Node resolves argv[1] to an
 * absolute path before we see it; `resolve` covers a caller-supplied relative one.
 */
export function resolveOrcadInstallRoot(scriptPath = process.argv[1]): string {
  if (!scriptPath) {
    throw new Error(
      'orcad_install_root_unavailable — process.argv[1] is unset, so this process has no ' +
        'bundle root to resolve sibling entry points against'
    )
  }
  return dirname(resolve(scriptPath))
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
    // Why inside userData rather than Electron's macOS ~/Library/Logs: a headless
    // deployment's whole state is one removable directory, and a service account
    // often has no Library tree to write into.
    case 'logs':
      return join(resolveUserDataPath(), 'logs')
    // The Node binary running this bundle. There is no app executable to point at.
    case 'exe':
      return process.execPath
    // The XDG user-dirs override, else the cross-platform default location.
    case 'downloads':
      return env('XDG_DOWNLOAD_DIR') ?? join(homedir(), 'Downloads')
  }
}
