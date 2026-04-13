import { Client as SshClient } from 'ssh2'
import type { ConnectConfig, ClientChannel } from 'ssh2'
import { type ChildProcess, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import type { Socket as NetSocket } from 'net'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'

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

// Why: prevents shell injection when interpolating into ProxyCommand.
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// Why: ssh2 doesn't check known_hosts. Without this, every connection blocks
// on a UI prompt that isn't wired up yet, causing a silent timeout.
function isHostKnown(host: string, port: number): boolean {
  try {
    const lookup = port === 22 ? host : `[${host}]:${port}`
    execFileSync('ssh-keygen', ['-F', lookup], { stdio: 'pipe', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

// ── Auth handler state (passed in by the connection) ────────────────

export type AuthHandlerState = {
  agentAttempted: boolean
  keyAttempted: boolean
  setState: (status: string, error?: string) => void
}

export type ConnectConfigResult = {
  config: ConnectConfig
  jumpClient: SshClient | null
  proxyProcess: ChildProcess | null
}
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
    // the handshake until `verify(true/false)` is called. We check
    // known_hosts first so trusted hosts connect without a UI prompt.
    hostVerifier: (key: Buffer, verify: (accept: boolean) => void) => {
      if (isHostKnown(target.host, target.port)) {
        verify(true)
        return
      }

      const fingerprint = createHash('sha256').update(key).digest('base64')
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

  let proxyProcess: ChildProcess | null = null
  if (target.proxyCommand) {
    const { spawn } = await import('child_process')
    const expanded = target.proxyCommand
      .replace(/%h/g, shellEscape(target.host))
      .replace(/%p/g, shellEscape(String(target.port)))
      .replace(/%r/g, shellEscape(target.username))
    proxyProcess = spawn('/bin/sh', ['-c', expanded], { stdio: ['pipe', 'pipe', 'pipe'] })
    // Why: a single PassThrough used for both directions creates a feedback loop —
    // proxy stdout data flows through the PassThrough and gets piped right back to
    // proxy stdin. Use a Duplex wrapper where reads come from stdout and writes
    // go to stdin independently.
    const { Duplex } = await import('stream')
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, cb) {
        proxyProcess!.stdin!.write(chunk, cb)
      }
    })
    proxyProcess.stdout!.on('data', (data) => stream.push(data))
    proxyProcess.stdout!.on('end', () => stream.push(null))
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

  return { config, jumpClient, proxyProcess }
}
