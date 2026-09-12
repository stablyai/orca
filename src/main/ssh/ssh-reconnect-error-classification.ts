import { isAuthError, isPassphraseError, isTransientError } from './ssh-connection-utils'
import { isHostKeyVerificationError } from './ssh-host-key-decision'

// Why: the system-SSH transport reports network failures as OpenSSH prose, not errno codes, so its
// probe timeouts and connect failures never match isTransientError's code table.
const NETWORK_LIKE_ERROR_FRAGMENTS = [
  'system ssh connection timed out',
  'timed out while waiting for handshake',
  'connection timed out',
  'operation timed out',
  'connection refused',
  'connection reset',
  'no route to host',
  'network is unreachable',
  'network is down',
  'host is down',
  'broken pipe',
  'temporary failure in name resolution',
  'name or service not known',
  'nodename nor servname',
  'could not resolve hostname',
  'kex_exchange_identification',
  // Pre-7.x OpenSSH wording for the same banner-exchange failure.
  'ssh_exchange_identification',
  'lost connection',
  'remote end closed',
  // Deliberately not the bare 'connection closed by': OpenSSH prints "Connection closed by <ip> port 22"
  // for server-side rejections (MaxStartups, DenyUsers) too, and those must stay permanent.
  'connection closed by remote'
]

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
