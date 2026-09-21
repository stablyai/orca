import type { ConnectConfig } from 'ssh2'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import {
  findEncryptedPrivateKeyPath,
  resolveAgentConfigValue,
  resolveAgentSocket,
  resolvePrivateKeys,
  resolveUnencryptedExplicitPrivateKeys
} from './ssh-auth-resolution'
import { configurePrivateKeyAuthentication } from './ssh-private-key-authentication'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

export { findDefaultKeyFile, resolveAgentSocket } from './ssh-auth-resolution'

export type SshCredentialKind = 'passphrase' | 'password' | 'keyboard-interactive'

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
  onCredentialRequest?: (
    targetId: string,
    kind: SshCredentialKind,
    detail: string,
    signal?: AbortSignal
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
export const SSH_CREDENTIAL_TIMEOUT_MS = 120_000

const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN'
])

function sshErrorLevel(err: Error): unknown {
  return 'level' in err ? err.level : undefined
}

export function isAuthError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes('all configured authentication methods failed') ||
    msg.includes('authentication failed') ||
    msg.includes('too many authentication failures') ||
    /permission denied(?:, please try again\.?| \([^)]*(?:publickey|password|keyboard-interactive|gssapi|hostbased)[^)]*\))/.test(
      msg
    ) ||
    sshErrorLevel(err) === 'client-authentication'
  )
}

export function isAgentFallbackError(err: Error): boolean {
  return isAuthError(err) || sshErrorLevel(err) === 'agent'
}

export function isTransientError(err: Error): boolean {
  if (
    sshErrorLevel(err) === 'client-timeout' ||
    err.message === 'Timed out while waiting for SSH authentication'
  ) {
    return true
  }
  const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined
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
  const effectiveUser =
    isOpenSshConfigBackedTarget(target) && resolved
      ? (resolved.user ?? target.username)
      : target.username || resolved?.user || ''

  const config: Record<string, unknown> = {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    tryKeyboard: true
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

  const keys =
    (options.includePrivateKey ?? !agent)
      ? resolvePrivateKeys(target, resolved)
      : resolveUnencryptedExplicitPrivateKeys(target, resolved)
  configurePrivateKeyAuthentication(
    config as ConnectConfig,
    keys,
    findEncryptedPrivateKeyPath(keys)
  )

  return config as ConnectConfig
}

function resolveEffectiveHost(target: SshTarget, resolved: SshResolvedConfig | null): string {
  if (isOpenSshConfigBackedTarget(target) && resolved?.hostname) {
    return resolved.hostname
  }
  if (shouldUseResolvedEndpoint(target, resolved)) {
    return resolved!.hostname
  }
  return target.host || resolved?.hostname || target.label
}

function resolveEffectivePort(target: SshTarget, resolved: SshResolvedConfig | null): number {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    return resolved.port || target.port || 22
  }
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
