import { removeChromiumDisabledSessionBus } from '../../../pty/shell-startup/chromium-session-bus-env'
import {
  buildConfiguredProxyEnv,
  PROXY_ENVIRONMENT_KEYS,
  PROXY_ENV_KEYS
} from '../../../../shared/network/network-proxy'
import { readNetworkProxySettings } from '../../../browser/network/execution-routes/browser-network-proxy-settings-source'

// Allowlist worker environment to exclude shell/CI credentials from third-party code.

const WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
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
  'NUMBER_OF_PROCESSORS'
] as const

// Route names only, never credentials: a worker is third-party code, but a worker that cannot reach
// the network Orca itself was started behind is useless behind a proxy.
const WORKER_PROXY_ENV_ALLOWLIST = ['NODE_USE_ENV_PROXY'] as const

function isProxyKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return PROXY_ENVIRONMENT_KEYS.some((proxyKey) => proxyKey.toLowerCase() === lowered)
}

function isProxyUrlKey(key: string): boolean {
  const lowered = key.toLowerCase()
  return PROXY_ENV_KEYS.some((proxyKey) => proxyKey.toLowerCase() === lowered)
}

export function buildPluginWorkerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
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
  for (const key of WORKER_PROXY_ENV_ALLOWLIST) {
    const value = platform === 'win32' ? windowsLookup.get(key) : baseEnv[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  // Keep every proxy spelling the platform inherited, so the worker takes the route Orca was
  // started with rather than reaching the internet directly.
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string' && isProxyKey(key)) {
      env[key] = value
    }
  }
  // A proxy configured in Settings never reaches this process's environment. Add it only when the
  // worker inherited no proxy route at all: a Settings value landing beside an inherited one under
  // a different spelling would leave the worker on two routes, and the bypass rules would not match.
  const inheritedProxyUrl = Object.entries(env).some(
    ([key, value]) => isProxyUrlKey(key) && value.trim() !== ''
  )
  if (!inheritedProxyUrl) {
    for (const [key, value] of Object.entries(
      buildConfiguredProxyEnv(readNetworkProxySettings())
    )) {
      if (env[key] === undefined) {
        env[key] = value
      }
    }
  }
  removeChromiumDisabledSessionBus(env)
  // Workers have no terminal; a git credential prompt would hang or grab the launching terminal.
  env.GIT_TERMINAL_PROMPT = '0'
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
