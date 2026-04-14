import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import type { SshConnectionState } from '../../shared/ssh-types'

// Why: types live here (not ssh-connection.ts) to break a circular import.

export type HostKeyVerifyRequest = {
  host: string
  ip: string
  fingerprint: string
  keyType: string
}

export type AuthChallengeRequest = {
  targetId: string
  name: string
  instructions: string
  prompts: { prompt: string; echo: boolean }[]
}

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
  onHostKeyVerify: (req: HostKeyVerifyRequest) => Promise<boolean>
  onAuthChallenge: (req: AuthChallengeRequest) => Promise<string[]>
  onPasswordPrompt: (targetId: string) => Promise<string | null>
}

export const INITIAL_RETRY_ATTEMPTS = 5
export const INITIAL_RETRY_DELAY_MS = 2000
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]
export const AUTH_CHALLENGE_TIMEOUT_MS = 60_000
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

// Why: prevents shell injection when interpolating into ProxyCommand.
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// Why: ssh2 only tries keys that are explicitly provided. Users with keys in
// standard locations (e.g. ~/.ssh/id_ed25519) but no SSH agent running would
// fail to authenticate. Probing default paths matches VS Code's behavior.
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

// Why: config-building logic extracted to ssh-connect-config.ts (max-lines).
export {
  buildConnectConfig,
  type AuthHandlerState,
  type ConnectConfigResult
} from './ssh-connect-config'
