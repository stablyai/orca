/**
 * Design D6 rung D: no Orca runtime runs on the host, so the target connects with plain SSH
 * terminals and SFTP browsing only. This module owns the per-target mode record and the
 * wording every relay-only feature uses when it refuses.
 */
import type { SshPlainSshMode } from '../../shared/ssh-types'
import type { RemoteRuntimeUnavailableError } from './ssh-relay-runtime-resolution'

const PLAIN_SSH_SUFFIX =
  ' Connected with plain SSH terminals and SFTP file browsing; these terminals end when the ' +
  'connection drops and are not restored on reconnect.'

const plainModes = new Map<string, SshPlainSshMode>()

export function plainSshModeFromRuntimeUnavailable(
  error: RemoteRuntimeUnavailableError
): SshPlainSshMode {
  return { reason: error.reason, message: `${error.message}${PLAIN_SSH_SUFFIX}` }
}

export function setSshPlainSshMode(targetId: string, mode: SshPlainSshMode): void {
  plainModes.set(targetId, mode)
}

export function clearSshPlainSshMode(targetId: string): void {
  plainModes.delete(targetId)
}

export function getSshPlainSshMode(targetId: string): SshPlainSshMode | undefined {
  return plainModes.get(targetId)
}

/** Refusal for an operation only the Orca remote server can perform. */
export class PlainSshUnsupportedError extends Error {
  readonly code = 'plain_ssh_unsupported'

  constructor(feature: string, mode: SshPlainSshMode | undefined) {
    const reason = mode ? ` (${mode.reason})` : ''
    super(`${feature} needs the Orca remote server, which is not running on this host${reason}.`)
    this.name = 'PlainSshUnsupportedError'
  }
}
