import { Client as SshClient } from 'ssh2'
import type { ConnectConfig, ClientChannel } from 'ssh2'
import { type ChildProcess, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import type { Socket as NetSocket } from 'net'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveWithSshG } from './ssh-config-parser'
import {
  shellEscape,
  findDefaultKeyFile,
  CONNECT_TIMEOUT_MS,
  type SshConnectionCallbacks
} from './ssh-connection-utils'
import { createAuthHandler } from './ssh-auth-handler'

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

// Why: ProxyJump values can be `user@host:port`, `host:port`, `user@host`,
// or just `host`. Parse all variants so jump host connections use the
// correct credentials instead of assuming port 22 and the target's username.
function parseJumpHost(raw: string): { host: string; port: number; username?: string } {
  let host = raw
  let port = 22
  let username: string | undefined

  const atIdx = host.indexOf('@')
  if (atIdx !== -1) {
    username = host.slice(0, atIdx)
    host = host.slice(atIdx + 1)
  }

  // Why: IPv6 addresses in ProxyJump are enclosed in brackets (e.g. [::1]:22).
  // Without special handling, lastIndexOf(':') matches inside the address.
  if (host.startsWith('[')) {
    const bracketEnd = host.indexOf(']')
    if (bracketEnd !== -1) {
      const afterBracket = host.slice(bracketEnd + 1)
      if (afterBracket.startsWith(':')) {
        const parsed = parseInt(afterBracket.slice(1), 10)
        if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
          port = parsed
        }
      }
      host = host.slice(1, bracketEnd)
      return { host, port, username }
    }
  }

  const colonIdx = host.lastIndexOf(':')
  if (colonIdx !== -1) {
    const portStr = host.slice(colonIdx + 1)
    const parsed = parseInt(portStr, 10)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed
      host = host.slice(0, colonIdx)
    }
  }

  return { host, port, username }
}

export type AuthHandlerState = {
  agentAttempted: boolean
  keyAttempted: boolean
  defaultKeyAttempted: boolean
  setState: (status: string, error?: string) => void
  pauseTimeout?: () => void
  resumeTimeout?: () => void
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
  // Why: `ssh -G` asks OpenSSH to resolve the full effective config for a
  // host alias, including Include directives, Match blocks, and wildcard
  // inheritance that our simple parser misses.
  const resolved = await resolveWithSshG(target.label).catch(() => null)
  const effectiveHost = target.host || resolved?.hostname || target.label
  const effectivePort = target.port || resolved?.port || 22
  const effectiveUser = target.username || resolved?.user || ''
  const effectiveIdentityFile = target.identityFile || (resolved?.identityFile?.[0] ?? undefined)
  // Why: `ssh -G` outputs `proxycommand none` and `proxyjump none` when
  // no proxy is configured. These are truthy strings that would cause us
  // to spawn `/bin/sh -c none` or SSH into a host literally named "none".
  const resolvedProxy =
    resolved?.proxyCommand && resolved.proxyCommand !== 'none' ? resolved.proxyCommand : undefined
  const resolvedJump =
    resolved?.proxyJump && resolved.proxyJump !== 'none' ? resolved.proxyJump : undefined
  const effectiveProxyCommand = target.proxyCommand || resolvedProxy || undefined
  const effectiveJumpHost = target.jumpHost || resolvedJump || undefined

  const config: ConnectConfig = {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    // Why: disabled (0) because SshConnection.attemptConnect() manages its own
    // pausable timeout. ssh2's readyTimeout cannot be paused and would race
    // with the manual timeout, killing connections during slow user prompts.
    readyTimeout: 0,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,

    // Why: ssh2's hostVerifier callback form `(key, verify) => void` blocks
    // the handshake until `verify(true/false)` is called.
    hostVerifier: (key: Buffer, verify: (accept: boolean) => void) => {
      if (isHostKnown(effectiveHost, effectivePort)) {
        verify(true)
        return
      }

      // Why: host key verification requires user interaction (UI prompt).
      // Without pausing, the 30s timeout keeps ticking while the user decides.
      authState.pauseTimeout?.()

      const fingerprint = createHash('sha256').update(key).digest('base64')
      const keyType = 'unknown'

      authState.setState('host-key-verification')
      callbacks
        .onHostKeyVerify({
          host: effectiveHost,
          ip: effectiveHost,
          fingerprint,
          keyType
        })
        .then((accepted) => {
          authState.resumeTimeout?.()
          verify(accepted)
        })
        .catch(() => {
          authState.resumeTimeout?.()
          verify(false)
        })
    },

    authHandler: createAuthHandler(
      effectiveUser,
      effectiveIdentityFile,
      target.id,
      callbacks,
      authState
    ) as ConnectConfig['authHandler']
  }

  if (effectiveIdentityFile) {
    try {
      config.privateKey = readFileSync(effectiveIdentityFile)
    } catch {
      // Will fall through to other auth methods
    }
  }

  if (process.env.SSH_AUTH_SOCK) {
    config.agent = process.env.SSH_AUTH_SOCK
  }

  // Why: when using agent auth, also provide a fallback key from default
  // paths so ssh2 can try publickey auth if the agent doesn't have the key.
  if (!config.privateKey && process.env.SSH_AUTH_SOCK) {
    const fallbackKey = findDefaultKeyFile()
    if (fallbackKey) {
      config.privateKey = fallbackKey.contents
    }
  }

  const proxyProcess = effectiveProxyCommand
    ? await setupProxyCommand(effectiveProxyCommand, effectiveHost, effectivePort, effectiveUser)
    : null
  if (proxyProcess) {
    config.sock = proxyProcess.sock
  }

  const jumpClient =
    effectiveJumpHost && !effectiveProxyCommand
      ? await setupJumpHost(effectiveJumpHost, effectiveHost, effectivePort, effectiveUser)
      : null
  if (jumpClient) {
    config.sock = jumpClient.sock
  }

  return {
    config,
    jumpClient: jumpClient?.client ?? null,
    proxyProcess: proxyProcess?.process ?? null
  }
}

async function setupProxyCommand(
  proxyCommand: string,
  host: string,
  port: number,
  user: string
): Promise<{ process: ChildProcess; sock: NetSocket }> {
  const { spawn } = await import('child_process')
  const expanded = proxyCommand
    .replace(/%h/g, shellEscape(host))
    .replace(/%p/g, shellEscape(String(port)))
    .replace(/%r/g, shellEscape(user))
  const proc = spawn('/bin/sh', ['-c', expanded], { stdio: ['pipe', 'pipe', 'pipe'] })
  // Why: a single PassThrough used for both directions creates a feedback loop.
  // Use a Duplex wrapper where reads come from stdout and writes go to stdin.
  const { Duplex } = await import('stream')
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      proc.stdin!.write(chunk, cb)
    }
  })
  proc.stdout!.on('data', (data) => stream.push(data))
  proc.stdout!.on('end', () => stream.push(null))
  // Why: if the proxy process crashes or fails to spawn, the unhandled
  // 'error' event would crash the Electron main process.
  proc.on('error', (err) => stream.destroy(err))
  return { process: proc, sock: stream as unknown as NetSocket }
}

// Why: the jump client is returned to the caller so it can be destroyed on
// disconnect — otherwise the intermediate TCP connection leaks.
async function setupJumpHost(
  jumpHost: string,
  targetHost: string,
  targetPort: number,
  targetUser: string
): Promise<{ client: SshClient; sock: NetSocket }> {
  const jumpClient = new SshClient()
  const jumpParsed = parseJumpHost(jumpHost)

  const jumpConfig: Record<string, unknown> = {
    host: jumpParsed.host,
    port: jumpParsed.port,
    username: jumpParsed.username ?? targetUser,
    agent: process.env.SSH_AUTH_SOCK ?? undefined,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    // Why: without hostVerifier, ssh2 accepts any host key, making the
    // jump host connection vulnerable to MITM attacks.
    hostVerifier: (_key: Buffer, verify: (accept: boolean) => void) => {
      verify(isHostKnown(jumpParsed.host, jumpParsed.port))
    }
  }
  const jumpKey = findDefaultKeyFile()
  if (jumpKey) {
    jumpConfig.privateKey = jumpKey.contents
  }

  await new Promise<void>((resolve, reject) => {
    jumpClient.on('ready', () => resolve())
    jumpClient.on('error', (err) => reject(err))
    jumpClient.connect(jumpConfig)
  })
  const forwardedChannel = await new Promise<ClientChannel>((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, channel) => {
      if (err) {
        reject(err)
      } else {
        resolve(channel)
      }
    })
  })
  return { client: jumpClient, sock: forwardedChannel as unknown as NetSocket }
}
