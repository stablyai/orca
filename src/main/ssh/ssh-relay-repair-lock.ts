import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import { isRelayGcClaimed } from './ssh-relay-gc-claim'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { INSTALL_LOCK_STALE_SECONDS, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { removeRemoteTreeCommand } from './ssh-remote-commands'

const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

export type RelayRepairLockResult = 'acquired' | 'busy' | 'gc' | 'error'

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
): Promise<RelayRepairLockResult> {
  const lockDir = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)
  try {
    const gcClaimedBeforeAcquire = await isRelayGcClaimed(
      conn,
      remoteRelayDir,
      host,
      options?.signal
    ).catch(() => undefined)
    options?.signal?.throwIfAborted()
    if (gcClaimedBeforeAcquire === true) {
      return 'gc'
    }
    if (gcClaimedBeforeAcquire !== false) {
      return 'error'
    }
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
      return finishRepairLockAcquire(conn, remoteRelayDir, lockDir, host, options?.signal)
    }
    const steal = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, lockDir, INSTALL_LOCK_STALE_SECONDS),
      options?.signal
    )
    if (steal.trim().endsWith('OK')) {
      console.warn(`[ssh-relay] Stealing stale install lock at ${lockDir}`)
      return finishRepairLockAcquire(conn, remoteRelayDir, lockDir, host, options?.signal)
    }
    return classifyRepairLockContention(conn, remoteRelayDir, lockDir, host, options?.signal)
  } catch {
    options?.signal?.throwIfAborted()
    return classifyRepairLockContention(conn, remoteRelayDir, lockDir, host, options?.signal)
  }
}

async function classifyRepairLockContention(
  conn: SshConnection,
  remoteRelayDir: string,
  lockDir: string,
  host: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<RelayRepairLockResult> {
  const gcClaimed = await isRelayGcClaimed(conn, remoteRelayDir, host, signal).catch(
    () => undefined
  )
  signal?.throwIfAborted()
  if (gcClaimed === true) {
    return 'gc'
  }
  if (gcClaimed !== false) {
    return 'error'
  }

  const lockProbe = await execHostCommand(
    conn,
    host,
    probeInstallLockExistsCommand(host, lockDir),
    signal
  ).catch(() => '')
  signal?.throwIfAborted()
  if (lockProbe.trim() !== 'LOCKED') {
    return 'error'
  }
  const ageOutput = await execHostCommand(
    conn,
    host,
    lockAgeSecondsCommand(host, lockDir),
    signal
  ).catch(() => '')
  signal?.throwIfAborted()
  const ageSeconds = Number.parseInt(ageOutput.trim(), 10)
  // Why: GC may remove stale locks, so only a positively observed fresh lock
  // proves that another launch/repair owner is fencing this directory.
  return Number.isFinite(ageSeconds) && ageSeconds >= 0 && ageSeconds <= INSTALL_LOCK_STALE_SECONDS
    ? 'busy'
    : 'error'
}

async function finishRepairLockAcquire(
  conn: SshConnection,
  remoteRelayDir: string,
  lockDir: string,
  host: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<RelayRepairLockResult> {
  const gcClaimed = await isRelayGcClaimed(conn, remoteRelayDir, host, signal).catch(
    () => undefined
  )
  if (gcClaimed === false && !signal?.aborted) {
    return 'acquired'
  }
  // Why: GC may win its stable sibling claim while this command creates the
  // in-tree lock. Back out before npm can mutate a directory being renamed.
  await execHostCommand(conn, host, removeRemoteTreeCommand(host, lockDir)).catch(() => {})
  signal?.throwIfAborted()
  return gcClaimed ? 'gc' : 'error'
}
