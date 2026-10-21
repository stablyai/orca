import { dirname, join } from 'node:path'
import { writeSecureFile } from '../../../shared/secure-file'
import type { SshTarget } from '../../../shared/ssh-types'
import { HostKeyVerificationError, hostKeyPolicyForOwner } from '../ssh-host-key-decision'
import { boundSshHostKeyStoreFile } from '../ssh-host-key-store'

/**
 * Provider-pinned targets reach system OpenSSH (every jump-host target does), which verifies only
 * from known_hosts. Their args always name a private file holding just the provider's keys, so
 * OpenSSH enforces the same pin as ssh2's verifier and never falls back to the user's known_hosts.
 */
function pinnedKnownHostsFile(target: SshTarget, storeFile: string | null): string | null {
  return storeFile ? join(dirname(storeFile), 'pinned-known-hosts', target.id) : null
}

/** Writes the pinned file before a system SSH connect; refuses a pin OpenSSH could not enforce. */
export function writePinnedKnownHosts(
  target: SshTarget,
  storeFile: string | null = boundSshHostKeyStoreFile()
): void {
  const policy = hostKeyPolicyForOwner(target.owner)
  if (policy.kind !== 'provider-pinned') {
    return
  }
  const refuse = (detail: string): never => {
    throw new HostKeyVerificationError(
      `Host key verification failed for ${target.label}. ${detail}`,
      'unknown'
    )
  }
  const file = pinnedKnownHostsFile(target, storeFile)
  if (!file) {
    return refuse('The host key store is not configured.')
  }
  if (policy.hostKeys.length === 0) {
    return refuse(
      'Its machine provider reported only key fingerprints, and this connection needs the full host keys to check them.'
    )
  }
  writeSecureFile(file, `${policy.hostKeys.map((key) => `${target.id} ${key}`).join('\n')}\n`)
}

/** Empty unless the target is provider-pinned; a missing file then fails closed in OpenSSH. */
export function pinnedKnownHostsArgs(
  target: SshTarget,
  storeFile: string | null = boundSshHostKeyStoreFile()
): string[] {
  if (hostKeyPolicyForOwner(target.owner).kind !== 'provider-pinned') {
    return []
  }
  // Quoted: OpenSSH splits these values on spaces, and app data paths often contain one.
  const file = `"${pinnedKnownHostsFile(target, storeFile) ?? 'none'}"`
  return [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${file}`,
    '-o',
    `GlobalKnownHostsFile=${file}`,
    '-o',
    `HostKeyAlias=${target.id}`,
    '-o',
    'CheckHostIP=no',
    '-o',
    'UpdateHostKeys=no'
  ]
}
