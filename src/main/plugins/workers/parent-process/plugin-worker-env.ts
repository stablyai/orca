import {
  getAppEnvironment,
  hasAppEnvironment
} from '../../../../shared/app-lifecycle/app-environment'
import { removeChromiumDisabledSessionBus } from '../../../pty/shell-startup/chromium-session-bus-env'

// Allowlist worker environment to exclude shell/CI credentials from third-party code.

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  // Login names (not credentials): Bun-built CLIs like Claude Code key Keychain logins by them.
  'USER',
  'LOGNAME',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Session socket pointers (not credentials) so git credential helpers and ssh-agent can connect.
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'SSH_AUTH_SOCK',
  // Windows Node/libuv need DLL and system-root lookup variables.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // Windows profile folders (paths, not credentials): the `orca` CLI finds the running app under %APPDATA%.
  'APPDATA',
  'LOCALAPPDATA',
  // The profile Orca runs from (a path, not a credential), so a worker's `orca` CLI reaches this app.
  'ORCA_USER_DATA_PATH'
] as const

export function buildPluginWorkerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userDataPath?: string
): Record<string, string> {
  const env: Record<string, string> = {}
  const windowsLookup = new Map<string, string>()
  if (platform === 'win32') {
    // Fold keys only on Windows; POSIX folding could promote an attacker-set lowercase path.
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === 'string') {
        windowsLookup.set(key.toUpperCase(), value)
      }
    }
  }
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = platform === 'win32' ? windowsLookup.get(key) : baseEnv[key]
    if (value !== undefined) {
      env[key === 'SYSTEMROOT' ? 'SystemRoot' : key] = value
    }
  }
  if (userDataPath) {
    env.ORCA_USER_DATA_PATH = userDataPath
  }
  removeChromiumDisabledSessionBus(env)
  // Workers have no terminal; a git credential prompt would hang or grab the launching terminal.
  env.GIT_TERMINAL_PROMPT = '0'
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** The environment a worker starts with, naming the profile this Orca runs from. */
export function pluginWorkerEnv(): Record<string, string> {
  const userDataPath = hasAppEnvironment() ? getAppEnvironment().getPath('userData') : undefined
  return buildPluginWorkerEnv(process.env, process.platform, userDataPath)
}
