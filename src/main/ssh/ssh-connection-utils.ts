import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import type { ConnectConfig } from 'ssh2'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
}

export const INITIAL_RETRY_ATTEMPTS = 5
export const INITIAL_RETRY_DELAY_MS = 2000
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]
export const CONNECT_TIMEOUT_MS = 30_000

const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN'
])

export function isTransientError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code
  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return true
  }
  if (err.message.includes('ETIMEDOUT')) {
    return true
  }
  if (err.message.includes('ECONNREFUSED')) {
    return true
  }
  if (err.message.includes('ECONNRESET')) {
    return true
  }
  return false
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// Why: ssh2 only tries keys that are explicitly provided. Users with keys in
// standard locations (e.g. ~/.ssh/id_ed25519) but no SSH agent running would
// fail to authenticate. Probing default paths matches VS Code's _findDefaultKeyFile.
const DEFAULT_KEY_PATHS = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa',
  '~/.ssh/id_xmss'
]

export function findDefaultKeyFile(): { path: string; contents: Buffer } | undefined {
  for (const keyPath of DEFAULT_KEY_PATHS) {
    const resolved = keyPath.replace(/^~/, homedir())
    try {
      if (!existsSync(resolved)) {
        continue
      }
      const contents = readFileSync(resolved)
      return { path: keyPath, contents }
    } catch {
      continue
    }
  }
  return undefined
}

// Why: matches VS Code's _connectSSH auth method selection (lines 606-611, 727-758).
// Picks ONE auth method before connecting and sets the corresponding config fields.
// ssh2 handles the auth negotiation natively — no custom authHandler needed.
export function buildConnectConfig(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): ConnectConfig {
  const effectiveHost = target.host || resolved?.hostname || target.label
  const effectivePort = target.port || resolved?.port || 22
  const effectiveUser = target.username || resolved?.user || ''

  const config: Record<string, unknown> = {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000
  }

  const resolvedIdentity = resolved?.identityFile?.[0]
  const explicitKey =
    target.identityFile ||
    (resolvedIdentity && !DEFAULT_KEY_PATHS.includes(resolvedIdentity)
      ? resolvedIdentity
      : undefined)

  if (explicitKey) {
    try {
      config.privateKey = readFileSync(explicitKey.replace(/^~/, homedir()))
    } catch {
      // Key unreadable — ssh2 will fail with auth error
    }
  } else {
    if (process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK
    }
    const fallback = findDefaultKeyFile()
    if (fallback) {
      config.privateKey = fallback.contents
    }
  }

  return config as ConnectConfig
}
