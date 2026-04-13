import { Client as SshClient } from 'ssh2'
import type { ConnectConfig, ClientChannel } from 'ssh2'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import type { Socket as NetSocket } from 'net'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'

// ── Callback types for UI integration ───────────────────────────────
// Why: these types live here (rather than in ssh-connection.ts) to avoid
// a circular import: ssh-connection.ts imports helpers from this file, and
// this file needs the callback types for buildConnectConfig.

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

// ── Constants (matching VS Code's remoteAgentConnection.ts) ─────────
// Why: extracted from ssh-connection.ts to keep each file under the
// 300-line oxlint max-lines threshold.

export const INITIAL_RETRY_ATTEMPTS = 5
export const INITIAL_RETRY_DELAY_MS = 2000
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 5000, 10000, 10000, 10000, 30000, 30000]
export const AUTH_CHALLENGE_TIMEOUT_MS = 60_000
export const CONNECT_TIMEOUT_MS = 15_000

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

/**
 * Why: ProxyCommand values are interpolated into a `/bin/sh -c` invocation.
 * Without escaping, a malicious hostname (e.g. `foo; rm -rf /`) would be
 * executed as shell code.  Wrapping in single quotes and escaping embedded
 * single quotes is the standard POSIX shell-safe quoting strategy.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// ── Auth handler state (passed in by the connection) ────────────────

export type AuthHandlerState = {
  agentAttempted: boolean
  keyAttempted: boolean
  setState: (status: string, error?: string) => void
}

/** Result of buildConnectConfig: the ssh2 config plus an optional jump host
 *  client that must be destroyed when the connection is torn down. */
export type ConnectConfigResult = {
  config: ConnectConfig
  /** The intermediate SshClient used for jump-host forwarding, if any.
   *  The caller is responsible for calling `.end()` on disconnect. */
  jumpClient: SshClient | null
}

/**
 * Build the ssh2 ConnectConfig for a target. Handles auth methods,
 * ProxyCommand, and JumpHost wiring.
 */
export async function buildConnectConfig(
  target: SshTarget,
  callbacks: SshConnectionCallbacks,
  authState: AuthHandlerState
): Promise<ConnectConfigResult> {
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 5000,
    keepaliveCountMax: 4,

    // Why: ssh2's hostVerifier callback form `(key, verify) => void` blocks
    // the handshake until `verify(true/false)` is called.  This lets us
    // prompt the user asynchronously without racing the 'ready' event.
    // We hash the raw host public key ourselves (no `hostHash` config) so
    // that the fingerprint reflects the actual key, not just its algorithm.
    hostVerifier: (key: Buffer, verify: (accept: boolean) => void) => {
      const fingerprint = createHash('sha256').update(key).digest('base64')
      // Why: ssh2 exposes the key type via the negotiated algorithms on the
      // handshake event, but we don't have that here.  Parsing the key
      // type from the raw public key buffer is fragile; 'unknown' is safe
      // because the fingerprint is the security-critical value.
      const keyType = 'unknown'

      authState.setState('host-key-verification')
      callbacks
        .onHostKeyVerify({
          host: target.host,
          ip: target.host,
          fingerprint,
          keyType
        })
        .then((accepted) => {
          verify(accepted)
        })
        .catch(() => {
          // Why: if the UI callback rejects (e.g. renderer crashed), we must
          // deny the host key to avoid silently trusting an unverified server.
          verify(false)
        })
    },

    authHandler: (methodsLeft, _partialSuccess, callback) => {
      // ssh2 passes null on the first call, meaning "try whatever you want".
      // Treat it as all methods available.
      const methods = methodsLeft ?? ['publickey', 'keyboard-interactive', 'password']

      // Try auth methods in order: agent -> publickey -> keyboard-interactive -> password
      // The custom authHandler overrides ssh2's built-in sequence, so we must
      // explicitly try agent auth here -- the config.agent field alone is not enough.
      if (methods.includes('publickey') && process.env.SSH_AUTH_SOCK && !authState.agentAttempted) {
        authState.agentAttempted = true
        callback({
          type: 'agent' as const,
          agent: process.env.SSH_AUTH_SOCK,
          username: target.username
        } as never)
        return
      }

      if (methods.includes('publickey') && target.identityFile && !authState.keyAttempted) {
        authState.keyAttempted = true
        try {
          callback({
            type: 'publickey' as const,
            username: target.username,
            key: readFileSync(target.identityFile)
          } as never)
          return
        } catch {
          // Key file unreadable -- fall through to next method
        }
      }

      if (methods.includes('keyboard-interactive')) {
        callback({
          type: 'keyboard-interactive' as const,
          username: target.username,
          prompt: async (
            _name: string,
            instructions: string,
            _lang: string,
            prompts: { prompt: string; echo: boolean }[],
            finish: (responses: string[]) => void
          ) => {
            authState.setState('auth-challenge')

            const timeoutPromise = sleep(AUTH_CHALLENGE_TIMEOUT_MS).then(() => null)
            const responsePromise = callbacks.onAuthChallenge({
              targetId: target.id,
              name: _name,
              instructions,
              prompts
            })

            const responses = await Promise.race([responsePromise, timeoutPromise])

            if (!responses) {
              finish([])
              return
            }
            finish(responses)
          }
        } as never)
        return
      }

      if (methods.includes('password')) {
        callbacks
          .onPasswordPrompt(target.id)
          .then((password) => {
            if (password === null) {
              authState.setState('auth-failed', 'Authentication cancelled')
              callback(false as never)
              return
            }
            callback({
              type: 'password' as const,
              username: target.username,
              password
            } as never)
          })
          .catch(() => {
            callback(false as never)
          })
        return
      }

      authState.setState('auth-failed', 'No supported authentication methods')
      callback(false as never)
    }
  }

  // If an identity file is specified, try it for the initial attempt
  if (target.identityFile) {
    try {
      config.privateKey = readFileSync(target.identityFile)
    } catch {
      // Will fall through to other auth methods
    }
  }

  // Try SSH agent by default
  if (process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK
  }

  // Wire ProxyCommand: ssh2 accepts a custom socket/stream via the `sock` option.
  // We spawn the ProxyCommand as a child process and pipe its stdio.
  // Why: tokens are shell-escaped to prevent injection — a hostile hostname
  // like "foo; rm -rf /" must not be interpreted as shell code.
  if (target.proxyCommand) {
    const { spawn } = await import('child_process')
    const expanded = target.proxyCommand
      .replace(/%h/g, shellEscape(target.host))
      .replace(/%p/g, shellEscape(String(target.port)))
      .replace(/%r/g, shellEscape(target.username))
    const proc = spawn('/bin/sh', ['-c', expanded], { stdio: ['pipe', 'pipe', 'pipe'] })
    const { PassThrough } = await import('stream')
    const stream = new PassThrough()
    proc.stdout!.pipe(stream)
    stream.pipe(proc.stdin!)
    config.sock = stream as unknown as NetSocket
  }

  // Wire JumpHost: establish an intermediate SSH connection and forward a channel.
  // Why: the jump client is returned to the caller so it can be destroyed on
  // disconnect — otherwise the intermediate TCP connection leaks.
  let jumpClient: SshClient | null = null
  if (target.jumpHost && !target.proxyCommand) {
    jumpClient = new SshClient()
    const jumpConn = jumpClient
    await new Promise<void>((resolve, reject) => {
      jumpConn.on('ready', () => resolve())
      jumpConn.on('error', (err) => reject(err))
      jumpConn.connect({
        host: target.jumpHost!,
        port: 22,
        username: target.username,
        agent: process.env.SSH_AUTH_SOCK ?? undefined,
        readyTimeout: CONNECT_TIMEOUT_MS
      })
    })
    const forwardedChannel = await new Promise<ClientChannel>((resolve, reject) => {
      jumpConn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel) => {
        if (err) {
          reject(err)
        } else {
          resolve(channel)
        }
      })
    })
    config.sock = forwardedChannel as unknown as NetSocket
  }

  return { config, jumpClient }
}
