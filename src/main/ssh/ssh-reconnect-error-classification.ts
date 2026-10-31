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

/** ssh2 supports fewer algorithms than OpenSSH (no host certificates, for one), so no shared algorithm is a client gap. */
export function isSsh2AlgorithmNegotiationError(err: Error): boolean {
  return err.message.startsWith('Handshake failed: no matching ')
}

// ssh2 lacks GSSAPI; use system SSH for config-enabled Kerberos only after auth-shaped failures, preserving network retry semantics.
export function isGssapiSystemSshFallbackCandidate(
  err: Error,
  target: Pick<SshTarget, 'gssapiAuthentication'>,
  resolved: Pick<SshResolvedConfig, 'gssapiAuthentication'> | null
): boolean {
  // Explicit per-host GSSAPI already tried system SSH; repeating cannot help.
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

// OpenSSH reports network faults as prose, bypassing errno-only initial-retry classification.
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
  // A stale NAT/forwarder can accept TCP then drop before SSH banner; retain ssh2's wording.
  'connection lost before handshake',
  'remote end closed',
  // Bare connection closed by includes permanent MaxStartups/DenyUsers refusal; require remote wording here.
  'connection closed by remote'
]

const DEFINITE_HOST_FAILURE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])

const OPENSSH_HOST_CONNECT_FAILURE =
  /\bconnect to host .+? port \d+: (?:connection (?:timed out|refused|reset(?: by peer)?)|operation timed out)\b/i

const EMPTY_SYSTEM_SSH_PROBE_EXIT_255 = /^system ssh probe failed \(exit 255\)\.$/

/** Keep broad network recovery in the bounded ladder: widening initial retries multiplies timeouts/key touches. Authentication remains permanent on both paths. */
export function isTransientReconnectError(err: Error): boolean {
  // Typed host-key denial stays final regardless of network-like reason text.
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
