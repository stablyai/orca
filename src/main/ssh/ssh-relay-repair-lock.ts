import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  acquireInstallLockParentCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { INSTALL_LOCK_STALE_SECONDS, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  return execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(host), signal })
}

/**
 * Try once to acquire the install lock for best-effort repair work.
 *
 * Why: a completed relay can launch in degraded mode, so repair must not wait
 * behind another installer. An already-stale lock is still recovered now.
 */
export async function tryAcquireRelayRepairLock(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: { signal?: AbortSignal }
): Promise<boolean> {
  const lockDir = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  try {
    await execHostCommand(
      conn,
      host,
      acquireInstallLockParentCommand(host, remoteRelayDir),
      options?.signal
    )
    const firstAttempt = await execHostCommand(
      conn,
      host,
      tryCreateInstallLockCommand(host, lockDir),
      options?.signal
    )
    if (firstAttempt.trim().endsWith('OK')) {
      return true
    }
    const steal = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, lockDir, INSTALL_LOCK_STALE_SECONDS),
      options?.signal
    )
    if (steal.trim().endsWith('OK')) {
      console.warn(`[ssh-relay] Stealing stale install lock at ${lockDir}`)
      return true
    }
    return false
  } catch {
    options?.signal?.throwIfAborted()
    return false
  }
}
