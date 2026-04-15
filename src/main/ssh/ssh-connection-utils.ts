import { readFileSync, existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { Duplex } from 'stream'
import type { Socket as NetSocket } from 'net'
import type { ConnectConfig } from 'ssh2'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'

export type SshCredentialKind = 'passphrase' | 'password'

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
  onCredentialRequest?: (
    targetId: string,
    kind: SshCredentialKind,
    detail: string
  ) => Promise<string | null>
}

export function isPassphraseError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return msg.includes('passphrase') || msg.includes('encrypted key') || msg.includes('bad decrypt')
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

export function isAuthError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes('all configured authentication methods failed') ||
    msg.includes('authentication failed') ||
    (err as { level?: string }).level === 'client-authentication'
  )
}

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

function cmdEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

// Why: ssh2 only tries keys that are explicitly provided. Users with keys in
// standard locations (e.g. ~/.ssh/id_ed25519) but no SSH agent running would
// fail to authenticate. Probing default paths matches VS Code's _findDefaultKeyFile.
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa', 'id_xmss']

const DEFAULT_KEY_PATHS = DEFAULT_KEY_NAMES.map((name) => `~/.ssh/${name}`)

// Why: parseSshGOutput expands ~ to homedir(), so resolved identityFile
// paths won't match the ~/... form in DEFAULT_KEY_PATHS. Pre-expand for
// the comparison in buildConnectConfig.
const EXPANDED_DEFAULT_KEY_PATHS = DEFAULT_KEY_NAMES.map((name) => join(homedir(), '.ssh', name))

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

  // Why: always provide agent when available. Unlike VS Code (which has a
  // passphrase prompt UI), we can't decrypt passphrase-protected keys at
  // runtime. The agent holds decrypted keys, so it must always be a
  // fallback even when an explicit key file is also provided.
  if (process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK
  }

  const resolvedIdentity = resolved?.identityFile?.[0]
  const explicitKey =
    target.identityFile ||
    (resolvedIdentity && !EXPANDED_DEFAULT_KEY_PATHS.includes(resolvedIdentity)
      ? resolvedIdentity
      : undefined)

  if (explicitKey) {
    try {
      config.privateKey = readFileSync(explicitKey.replace(/^~/, homedir()))
    } catch {
      // Key unreadable — agent will handle auth if available
    }
  } else {
    const fallback = findDefaultKeyFile()
    if (fallback) {
      config.privateKey = fallback.contents
    }
  }

  return config as ConnectConfig
}

// Why: ProxyJump and jumpHost are syntactic sugar for ProxyCommand.
// OpenSSH internally converts `ProxyJump bastion` to
// `ProxyCommand ssh -W %h:%p bastion`. We do the same so that ssh2
// gets a single proxy spawn path regardless of how the tunnel was configured.
export type EffectiveProxy =
  | { kind: 'proxy-command'; command: string }
  | { kind: 'jump-host'; jumpHost: string }

export function resolveEffectiveProxy(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): EffectiveProxy | undefined {
  if (target.proxyCommand) {
    return { kind: 'proxy-command', command: target.proxyCommand }
  }
  if (resolved?.proxyCommand) {
    return { kind: 'proxy-command', command: resolved.proxyCommand }
  }
  const jump = target.jumpHost || resolved?.proxyJump
  if (jump) {
    return { kind: 'jump-host', jumpHost: jump }
  }
  return undefined
}

// Why: ssh2 doesn't natively support ProxyCommand. When the SSH config
// specifies one (e.g. `cloudflared access ssh --hostname %h`), we spawn
// the command and bridge its stdin/stdout into a Duplex stream that ssh2
// uses as its transport socket via `config.sock`.
function getShellSpawnConfig(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

export function spawnProxyCommand(
  proxy: EffectiveProxy,
  host: string,
  port: number,
  user: string
): { process: ChildProcess; sock: NetSocket } {
  const proc =
    proxy.kind === 'jump-host'
      ? // Why: ProxyJump is structured input, not a shell snippet. Spawn ssh
        // directly so jump-host values cannot escape through shell parsing.
        spawn('ssh', ['-W', `${host}:${port}`, '--', proxy.jumpHost], { stdio: ['pipe', 'pipe', 'pipe'] })
      : (() => {
          const escape = process.platform === 'win32' ? cmdEscape : shellEscape
          const expanded = proxy.command
            .replace(/%h/g, escape(host))
            .replace(/%p/g, escape(String(port)))
            .replace(/%r/g, escape(user))
          const shell = getShellSpawnConfig(expanded)
          return spawn(shell.file, shell.args, { stdio: ['pipe', 'pipe', 'pipe'] })
        })()

  // Why: a single PassThrough for both directions creates a feedback loop.
  // Reads come from the proxy's stdout; writes go to its stdin.
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      proc.stdin!.write(chunk, cb)
    }
  })
  proc.stdout!.on('data', (data) => stream.push(data))
  proc.stdout!.on('end', () => stream.push(null))
  proc.stdin!.on('error', (err) => stream.destroy(err))
  proc.on('error', (err) => stream.destroy(err))

  return { process: proc, sock: stream as unknown as NetSocket }
}
