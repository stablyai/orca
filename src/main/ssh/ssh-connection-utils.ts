import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'
import type { Socket as NetSocket } from 'node:net'
import type { ConnectConfig } from 'ssh2'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import {
  resolveAgentConfigValue,
  resolveAgentSocket,
  resolvePrivateKey,
  resolveUnencryptedExplicitPrivateKey
} from './ssh-auth-resolution'

export { findDefaultKeyFile, resolveAgentSocket } from './ssh-auth-resolution'

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
    msg.includes('too many authentication failures') ||
    (err as { level?: string }).level === 'client-authentication'
  )
}

export function isAgentFallbackError(err: Error): boolean {
  return isAuthError(err) || (err as { level?: string }).level === 'agent'
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

const SYSTEM_SSH_FALLBACK_ERROR_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH'])

export function isSystemSshFallbackError(err: Error): boolean {
  const code = (err as NodeJS.ErrnoException).code
  if (code && SYSTEM_SSH_FALLBACK_ERROR_CODES.has(code)) {
    return true
  }
  return err.message.includes('EHOSTUNREACH') || err.message.includes('ENETUNREACH')
}

// Why: ssh2 has no gssapi-with-mic support. When the effective OpenSSH config
// enables GSSAPIAuthentication (often a distro-wide /etc/ssh default), a
// Kerberos ticket can still authenticate through the system ssh binary after
// key/agent auth fails — but only auth-shaped failures qualify, so network
// errors keep their existing retry semantics.
export function isGssapiSystemSshFallbackCandidate(
  err: Error,
  target: Pick<SshTarget, 'gssapiAuthentication'>,
  resolved: Pick<SshResolvedConfig, 'gssapiAuthentication'> | null
): boolean {
  // Why: targets with an explicit per-host flag already tried system ssh
  // proactively during this attempt; probing again cannot succeed.
  if (target.gssapiAuthentication === true) {
    return false
  }
  return (isAuthError(err) || isPassphraseError(err)) && resolved?.gssapiAuthentication === true
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

const REMOTE_COMMAND_CHUNK_MAX_BYTES = 1_024
const REMOTE_COMMAND_PRINTF_ESCAPED_BYTES = new Set([0x21, 0x27, 0x5c])

function encodeRemoteCommandForPrintf(command: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const character of command) {
    const codePoint = character.codePointAt(0)!
    const isSafePrintableAscii =
      codePoint >= 0x20 && codePoint <= 0x7e && !REMOTE_COMMAND_PRINTF_ESCAPED_BYTES.has(codePoint)
    const encodedCharacter =
      codePoint > 0x7f || isSafePrintableAscii
        ? character
        : `\\0${codePoint.toString(8).padStart(3, '0')}`
    const encodedBytes = codePoint > 0x7f ? Buffer.byteLength(character) : encodedCharacter.length
    if (chunkBytes + encodedBytes > REMOTE_COMMAND_CHUNK_MAX_BYTES) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += encodedCharacter
    chunkBytes += encodedBytes
  }
  chunks.push(chunk)
  return chunks
}

/** Wrap a POSIX snippet into one line that non-POSIX SSH login shells can forward. */
export function wrapRemoteCommandForPosixShell(command: string): string {
  // Why: csh/tcsh split multiline SSH exec strings before /bin/sh sees them.
  // POSIX printf rebuilds bounded argument chunks without consuming relay stdin.
  const encodedChunks = encodeRemoteCommandForPrintf(command)
  const decodeAndRun =
    'decoded=$(printf %b "$@" && printf _) || exit $?; ' +
    'decoded=${decoded%_}; exec /bin/sh -c "$decoded"'
  const chunkArguments = encodedChunks.map(shellEscape).join(' ')
  return `exec /bin/sh -c ${shellEscape(decodeAndRun)} orca-command ${chunkArguments}`
}

export type SshExecOptions = {
  wrapCommand?: boolean
  signal?: AbortSignal
}

export function createSshOperationAbortError(): Error & { name: string } {
  const error = new Error('SSH operation was cancelled') as Error & { name: string }
  error.name = 'AbortError'
  return error
}

function cmdEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

type BuildConnectConfigOptions = {
  includeAgent?: boolean
  includePrivateKey?: boolean
}

// Why: ssh2 tries privateKey before agent, but parses encrypted privateKey
// values before any agent auth can run. Keep unencrypted explicit keys first
// while deferring encrypted keys until the post-agent passphrase path.
export function buildConnectConfig(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: BuildConnectConfigOptions = {}
): ConnectConfig {
  const effectiveHost = resolveEffectiveHost(target, resolved)
  const effectivePort = resolveEffectivePort(target, resolved)
  const effectiveUser = target.username || resolved?.user || ''

  const config: Record<string, unknown> = {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000
  }

  const shouldIncludeAgent = options.includeAgent ?? true
  const agentSocket = shouldIncludeAgent ? resolveAgentSocket(target, resolved) : undefined
  const agent = agentSocket ? resolveAgentConfigValue(agentSocket, target, resolved) : undefined

  if (agent) {
    config.agent = agent
  }

  if (agent && resolved?.forwardAgent) {
    config.agentForward = true
  }

  const key =
    (options.includePrivateKey ?? !agent)
      ? resolvePrivateKey(target, resolved)
      : resolveUnencryptedExplicitPrivateKey(target, resolved)
  if (key) {
    config.privateKey = key.contents
  }

  return config as ConnectConfig
}

function resolveEffectiveHost(target: SshTarget, resolved: SshResolvedConfig | null): string {
  if (shouldUseResolvedEndpoint(target, resolved)) {
    return resolved!.hostname
  }
  return target.host || resolved?.hostname || target.label
}

function resolveEffectivePort(target: SshTarget, resolved: SshResolvedConfig | null): number {
  // Why: imported config aliases store 22 as the schema default even when an
  // included/wildcard OpenSSH rule later resolves a different effective Port.
  if (target.configHost && target.port === 22 && resolved?.port) {
    return resolved.port
  }
  return target.port || resolved?.port || 22
}

function shouldUseResolvedEndpoint(target: SshTarget, resolved: SshResolvedConfig | null): boolean {
  if (!target.configHost || !resolved?.hostname) {
    return false
  }
  const host = target.host.trim()
  return host === '' || host === target.configHost || host === target.label
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
        spawn('ssh', ['-W', `${host}:${port}`, '--', proxy.jumpHost], {
          stdio: ['pipe', 'pipe', 'pipe']
        })
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
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    proc.stdout!.off('data', onStdoutData)
    proc.stdout!.off('end', onStdoutEnd)
    proc.stdin!.off('error', onInputError)
    proc.off('error', onProcessError)
  }
  const onStdoutData = (data: Buffer): void => {
    stream.push(data)
  }
  const onStdoutEnd = (): void => {
    stream.push(null)
  }
  const onInputError = (err: Error): void => {
    stream.destroy(err)
  }
  const onProcessError = (err: Error): void => {
    stream.destroy(err)
  }
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      proc.stdin!.write(chunk, cb)
    },
    destroy(err, cb) {
      cleanup()
      cb(err)
    }
  })
  proc.stdout!.on('data', onStdoutData)
  proc.stdout!.on('end', onStdoutEnd)
  proc.stdin!.on('error', onInputError)
  proc.on('error', onProcessError)

  return { process: proc, sock: stream as unknown as NetSocket }
}
