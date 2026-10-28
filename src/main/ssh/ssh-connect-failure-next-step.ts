import { isHostKeyVerificationError } from './ssh-host-key-decision'
import { isAuthError, isPassphraseError } from './ssh-reconnect-error-classification'

type FailureKind =
  | 'host-key'
  | 'auth'
  | 'passphrase'
  | 'refused'
  | 'host-name'
  | 'unreachable'
  | 'timeout'

const NEXT_STEPS: Record<FailureKind, string> = {
  'host-key':
    'SSH couldn’t confirm this host’s identity. Run ssh to this host in a terminal to see why and trust or update its key, then connect again.',
  auth: 'The host didn’t accept any sign-in Orca offered. Check the user name and the key, ssh-agent or password for this host, then connect again.',
  passphrase: 'Orca couldn’t unlock the SSH key. Check its passphrase, then connect again.',
  refused:
    'Nothing accepted the SSH connection at this address. Check the host name and port, and that sshd is running on the host.',
  'host-name': 'The host name couldn’t be looked up. Check the name and your network connection.',
  unreachable:
    'There’s no network route to the host. Check your network or VPN, then connect again.',
  timeout:
    'The connection didn’t finish in time. Check that the host is reachable from this computer (network, VPN, firewall), then connect again.'
}

// SSH's own wording, raw or through system ssh, names the failure; match it, not exact codes alone.
function classify(error: Error): FailureKind | null {
  // Orca's own host-key refusals already name their exact fix.
  if (isHostKeyVerificationError(error) || /cancel/i.test(error.message)) {
    return null
  }
  if (/host key verification failed/i.test(error.message)) {
    return 'host-key'
  }
  if (isPassphraseError(error)) {
    return 'passphrase'
  }
  if (isAuthError(error)) {
    return 'auth'
  }
  const text = `${'code' in error ? String(error.code) : ''} ${error.message}`.toLowerCase()
  if (/econnrefused|connection refused/.test(text)) {
    return 'refused'
  }
  if (
    /enotfound|eai_again|could not resolve hostname|name or service not known|nodename nor servname/.test(
      text
    )
  ) {
    return 'host-name'
  }
  if (/ehostunreach|enetunreach|no route to host|network is unreachable/.test(text)) {
    return 'unreachable'
  }
  if (/etimedout|timed out/.test(text)) {
    return 'timeout'
  }
  return null
}

/** SSH's reason, led by what to do about it when the failure is one users can act on. */
export function describeSshConnectFailure(error: Error): string {
  const kind = classify(error)
  return kind ? `${NEXT_STEPS[kind]} (${error.message})` : error.message
}
