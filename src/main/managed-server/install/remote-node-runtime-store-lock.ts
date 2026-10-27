// Promotion waits for the store lock; GC skips busy stores rather than queuing behind installs.
import { randomUUID } from 'node:crypto'
import { ORCAD_RUNTIMES_DIRNAME } from '../../../shared/orcad-artifacts'
import type { RemoteInstallTransport } from './remote-install-transport'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, INSTALL_LOCK_STALE_SECONDS } from './remote-install-lock'
import {
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand,
  type InstallLockOwnerFile
} from './remote-install-lock-commands'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { removeRemoteTreeCommand } from '../../ssh/ssh-remote-commands'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

export const RUNTIME_STORE_LOCK_NAME = '.store-lock'
// Owner tokens prevent late releases from deleting successor locks.
export const RUNTIME_STORE_LOCK_OWNER_FILENAME = '.holder'

export type HeldRuntimeStoreLock = {
  /** Host-side release keeps the lock with work that outlives its client's timeout or channel. */
  releasedByHostOnExit(command: string): string
}

export function remoteNodeRuntimeStoreDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_RUNTIMES_DIRNAME)
}

function lockDir(host: RemoteHostPlatform, storeDir: string): string {
  return joinRemotePath(host, storeDir, RUNTIME_STORE_LOCK_NAME)
}

export function posixReleaseOwnedLockCommand(
  host: RemoteHostPlatform,
  lock: string,
  owner: InstallLockOwnerFile
): string {
  const ownerPath = quotePosixShell(joinRemotePath(host, lock, owner.fileName))
  return `[ "$(cat ${ownerPath} 2>/dev/null)" = ${quotePosixShell(owner.token)} ] && rm -rf ${quotePosixShell(lock)}`
}

function heldLock(
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile
): HeldRuntimeStoreLock {
  return {
    releasedByHostOnExit: (command) => {
      if (isWindowsRemoteHost(host)) {
        throw new Error('The runtime store lock is released by the host only on POSIX hosts.')
      }
      // Ignore hangups and capture output so release precedes writes to a potentially closed channel.
      return (
        `trap '' HUP PIPE; orca_store_out=$(${command}); orca_store_status=$?; ` +
        `${posixReleaseOwnedLockCommand(host, lockDir(host, storeDir), owner)}; ` +
        `printf '%s\\n' "$orca_store_out"; exit $orca_store_status`
      )
    }
  }
}

async function releaseRuntimeStoreLock(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile
): Promise<void> {
  const windows = isWindowsRemoteHost(host)
  const lock = lockDir(host, storeDir)
  // Host-side release may already have allowed a successor to acquire the lock.
  const command = windows
    ? removeRemoteTreeCommand(host, lock)
    : `${posixReleaseOwnedLockCommand(host, lock, owner)} || true`
  await execHostCommand(conn, host, command).catch((error) => {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
  })
}

/** Attempt once; only stale or previous-boot locks permit takeover. */
async function tryAcquireRuntimeStoreLock(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile,
  signal?: AbortSignal
): Promise<boolean> {
  const lock = lockDir(host, storeDir)
  try {
    const created = await execHostCommand(
      conn,
      host,
      tryCreateInstallLockCommand(host, lock, owner),
      {
        signal
      }
    )
    if (created.trim().endsWith('OK')) {
      return true
    }
    const stolen = await execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, lock, INSTALL_LOCK_STALE_SECONDS, owner),
      { signal }
    )
    return stolen.trim().endsWith('OK')
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    signal?.throwIfAborted()
    return false
  }
}

function newOwner(): InstallLockOwnerFile {
  return { fileName: RUNTIME_STORE_LOCK_OWNER_FILENAME, token: randomUUID() }
}

async function runHoldingLock<T>(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile,
  task: (held: HeldRuntimeStoreLock) => Promise<T>
): Promise<T> {
  let value: T
  try {
    value = await task(heldLock(host, storeDir, owner))
  } catch (error) {
    // Unconfirmed remote work may still need the lock.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await releaseRuntimeStoreLock(conn, host, storeDir, owner)
    }
    throw error
  }
  await releaseRuntimeStoreLock(conn, host, storeDir, owner)
  return value
}

export async function withRuntimeStoreLock<T>(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  storeDir: string,
  task: (held: HeldRuntimeStoreLock) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const owner = newOwner()
  await acquireInstallLock(conn, storeDir, host, {
    signal,
    lockName: RUNTIME_STORE_LOCK_NAME,
    relayGcClaim: false,
    owner
  })
  return runHoldingLock(conn, host, storeDir, owner, task)
}

/** Skip busy stores instead of waiting; return null. */
export async function tryWithRuntimeStoreLock<T>(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  storeDir: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<{ value: T } | null> {
  const owner = newOwner()
  if (!(await tryAcquireRuntimeStoreLock(conn, host, storeDir, owner, signal))) {
    return null
  }
  return { value: await runHoldingLock(conn, host, storeDir, owner, task) }
}
