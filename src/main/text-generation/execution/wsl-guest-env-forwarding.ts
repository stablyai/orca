import { addWslEnvKeys } from '../../../shared/shell/wsl/wsl-env'

const LAUNCHER_KEYS = new Set([
  'ComSpec',
  'COMSPEC',
  'Path',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'WINDIR',
  'WSLENV',
  'WSL_UTF8'
])

// Windows values for these replace the guest's own paths. WSLENV must not carry them.
const GUEST_BLOCKED = new Set(['PATH', 'HOME', 'TMP', 'TEMP', 'PATHEXT'])

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** `/p` translates Windows paths. `/u` copies POSIX paths, URLs, and explicit empty strings unchanged. */
function wslenvFlag(value: string): 'p' | 'u' {
  return isWindowsPath(value) ? 'p' : 'u'
}

function guestAssignmentAllowed(key: string, value: string): boolean {
  // Values may contain newlines (custom header blocks). Keys must stay a single assignment token.
  return !key.includes('=') && !key.includes('\0') && !/[\r\n]/.test(key) && !value.includes('\0')
}

/** Launch env, then the account patch. Callers forward these keys even when they match `process.env`. */
export function guestOverrideEnv(
  launchEnv: NodeJS.ProcessEnv | undefined,
  accountPatch: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv | undefined {
  const overrides: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(launchEnv ?? {})) {
    if (typeof value === 'string') {
      overrides[key] = value
    }
  }
  for (const [key, value] of Object.entries(accountPatch ?? {})) {
    if (typeof value === 'string') {
      overrides[key] = value
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

/**
 * Publish launcher overrides into the guest. Windows paths cross only through WSLENV `/p`
 * so a later assignment cannot replace the translated path. Every other defined value,
 * including `""`, is also assigned after the login shell.
 */
export function publishWslGuestOverrides(env: NodeJS.ProcessEnv): string[] {
  const tokens: string[] = []
  const assignments: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value !== 'string' ||
      LAUNCHER_KEYS.has(key) ||
      GUEST_BLOCKED.has(key.toUpperCase())
    ) {
      continue
    }
    if (!guestAssignmentAllowed(key, value)) {
      continue
    }
    tokens.push(`${key}/${wslenvFlag(value)}`)
    if (!isWindowsPath(value)) {
      assignments.push(`${key}=${value}`)
    }
  }
  if (tokens.length > 0) {
    addWslEnvKeys(env, tokens)
  }
  return assignments
}
