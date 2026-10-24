import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './config/ssh-g-config-resolution'
import { isHostKeyVerificationError } from './ssh-host-key-decision'

export function isPassphraseError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return msg.includes('passphrase') || msg.includes('encrypted key') || msg.includes('bad decrypt')
}

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
  const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined
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

const DEFINITE_HOST_FAILURE_FRAGMENTS = [
  'no route to host',
  'network is unreachable',
  'network is down',
  'host is down',
  'temporary failure in name resolution',
  'name or service not known',
  'nodename nor servname',
  'could not resolve hostname'
]

// Why: the system-SSH transport reports network failures as OpenSSH prose, not errno codes, so its
// probe timeouts and connect failures never match isTransientError's code table.
const NETWORK_LIKE_ERROR_FRAGMENTS = [
  ...DEFINITE_HOST_FAILURE_FRAGMENTS,
  'system ssh connection timed out',
  'timed out while waiting for handshake',
  'connection timed out',
  'operation timed out',
  'connection refused',
  'connection reset',
  'broken pipe',
  'kex_exchange_identification',
  // Pre-7.x OpenSSH wording for the same banner-exchange failure.
  'ssh_exchange_identification',
  'lost connection',
  // ssh2's wording when TCP connects but the socket closes before the server's banner, as it does
  // while a port forwarder or NAT still accepts connections for a host it can no longer reach.
  'connection lost before handshake',
  'remote end closed',
  // Deliberately not the bare 'connection closed by': OpenSSH prints "Connection closed by <ip> port 22"
  // for server-side rejections (MaxStartups, DenyUsers) too, and those must stay permanent.
  'connection closed by remote'
]

const DEFINITE_HOST_FAILURE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])

const OPENSSH_HOST_CONNECT_FAILURE =
  /\bconnect to host .+? port \d+: (?:connection (?:timed out|refused|reset(?: by peer)?)|operation timed out)\b/i

const EMPTY_SYSTEM_SSH_PROBE_EXIT_255 = /^system ssh probe failed \(exit 255\)\.$/

/**
 * Why a second classifier: connect() spends isTransientError on INITIAL_RETRY_ATTEMPTS, so widening
 * it would turn one 30s system-SSH timeout into ~160s of silence and five security-key touch
 * prompts. The reconnect ladder has its own backoff and give-up bound, so it can afford to treat a
 * network-shaped failure as recoverable. Auth stays permanent on both paths.
 */
export function isTransientReconnectError(err: Error): boolean {
  // A denied host key is a decision, not a fault: retrying re-derives the same answer, so the ladder
  // would back off forever against a host it has already refused. Checked by type rather than left
  // to the fragment lists below, which would silently start retrying if the wording changed.
  if (isHostKeyVerificationError(err)) {
    return false
  }
  if (isAuthError(err) || isPassphraseError(err)) {
    return false
  }
  if (isTransientError(err)) {
    return true
  }
  const message = err.message.toLowerCase()
  return (
    EMPTY_SYSTEM_SSH_PROBE_EXIT_255.test(message) ||
    NETWORK_LIKE_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment))
  )
}

/** Definite host failures where a ControlMaster-free retry cannot help. */
export function isDefiniteSystemSshHostFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false
  }
  const code = (err as NodeJS.ErrnoException).code
  if (code && DEFINITE_HOST_FAILURE_CODES.has(code)) {
    return true
  }
  const message = err.message.toLowerCase()
  return (
    DEFINITE_HOST_FAILURE_FRAGMENTS.some((fragment) => message.includes(fragment)) ||
    OPENSSH_HOST_CONNECT_FAILURE.test(err.message)
  )
}
