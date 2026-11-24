import { removeChromiumDisabledSessionBus } from '../../../pty/shell-startup/chromium-session-bus-env'
import { PROXY_ENV_KEYS, PROXY_ENVIRONMENT_KEYS } from '../../../../shared/network/network-proxy'

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
  'NUMBER_OF_PROCESSORS',
  // Node's own fetch and http read the proxy variables only when this is set.
  'NODE_USE_ENV_PROXY'
] as const

const PROXY_URL_KEYS: ReadonlySet<string> = new Set(PROXY_ENV_KEYS)

// A proxy URL passes only without a user part; `user:pass@proxy:8080` has no host and hides one.
function isCredentialFreeProxyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.host !== '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
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
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    // NO_PROXY is a host list and passes as is; on Windows one variable answers to either case.
    const name = platform === 'win32' ? key.toUpperCase() : key
    const value = platform === 'win32' ? windowsLookup.get(name) : baseEnv[name]
    if (value !== undefined && (!PROXY_URL_KEYS.has(key) || isCredentialFreeProxyUrl(value))) {
      env[name] = value
    }
  }
  removeChromiumDisabledSessionBus(env)
  // Workers have no terminal; a git credential prompt would hang or grab the launching terminal.
  env.GIT_TERMINAL_PROMPT = '0'
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
