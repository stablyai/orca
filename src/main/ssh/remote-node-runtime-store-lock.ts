/**
 * The `runtimes/` store's mkdir lock (design D5). Promotion waits for it; store GC only tries it,
 * so a collector never queues behind an install. Both use the install lock's primitives and its
 * 20-minute stale rule.
 */
import { randomUUID } from 'node:crypto'
import { ORCAD_RUNTIMES_DIRNAME } from '../../shared/orcad-artifacts'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { acquireInstallLock, INSTALL_LOCK_STALE_SECONDS } from './ssh-relay-install-lock'
import {
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand,
  type InstallLockOwnerFile
} from './ssh-relay-install-lock-commands'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export const RUNTIME_STORE_LOCK_NAME = '.store-lock'
/** Names the holder, so a release never removes a lock someone else took after it. */
export const RUNTIME_STORE_LOCK_OWNER_FILENAME = '.holder'

/** The store lock as held by one task. */
export type HeldRuntimeStoreLock = {
  /**
   * POSIX: wraps `command` so the host itself releases this lock when the command exits. A client
   * that stopped waiting (timeout, lost channel) then leaves the lock with the work that is still
   * running, not for the 20-minute stale rule (HH-3).
   */
  releasedByHostOnExit(command: string): string
}

export function remoteNodeRuntimeStoreDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_RUNTIMES_DIRNAME)
}

function lockDir(host: RemoteHostPlatform, storeDir: string): string {
  return joinRemotePath(host, storeDir, RUNTIME_STORE_LOCK_NAME)
}

function posixReleaseOwnedLockCommand(
  host: RemoteHostPlatform,
  lock: string,
  owner: InstallLockOwnerFile
): string {
  const ownerPath = shellEscape(joinRemotePath(host, lock, owner.fileName))
  return `[ "$(cat ${ownerPath} 2>/dev/null)" = ${shellEscape(owner.token)} ] && rm -rf ${shellEscape(lock)}`
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
      // Why ignore HUP/PIPE: a client that hung up must not stop the release, and capturing the
      // output keeps the release ahead of the first write to a closed channel.
      return (
        `trap '' HUP PIPE; orca_store_out=$(${command}); orca_store_status=$?; ` +
        `${posixReleaseOwnedLockCommand(host, lockDir(host, storeDir), owner)}; ` +
        `printf '%s\\n' "$orca_store_out"; exit $orca_store_status`
      )
    }
  }
}

async function releaseRuntimeStoreLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile
): Promise<void> {
  const windows = isWindowsRemoteHost(host)
  const lock = lockDir(host, storeDir)
  // Why owner-checked on POSIX: the host may already have released it and another holder taken it.
  const command = windows
    ? removeRemoteTreeCommand(host, lock)
    : `${posixReleaseOwnedLockCommand(host, lock, owner)} || true`
  await execCommand(conn, command, { wrapCommand: !windows }).catch((error) => {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
  })
}

/** One attempt, stealing only a stale or previous-boot lock. A missing store is simply not acquired. */
async function tryAcquireRuntimeStoreLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile,
  signal?: AbortSignal
): Promise<boolean> {
  const lock = lockDir(host, storeDir)
  try {
    // Why unwrapped on Windows: these are already self-contained powershell.exe command lines.
    const wrapCommand = !isWindowsRemoteHost(host)
    const created = await execCommand(conn, tryCreateInstallLockCommand(host, lock, owner), {
      signal,
      wrapCommand
    })
    if (created.trim().endsWith('OK')) {
      return true
    }
    const stolen = await execCommand(
      conn,
      tryStealInstallLockCommand(host, lock, INSTALL_LOCK_STALE_SECONDS, owner),
      { signal, wrapCommand }
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
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  owner: InstallLockOwnerFile,
  task: (held: HeldRuntimeStoreLock) => Promise<T>
): Promise<T> {
  let value: T
  try {
    value = await task(heldLock(host, storeDir, owner))
  } catch (error) {
    // Why keep it on an unconfirmed termination: the remote step may still be running.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await releaseRuntimeStoreLock(conn, host, storeDir, owner)
    }
    throw error
  }
  await releaseRuntimeStoreLock(conn, host, storeDir, owner)
  return value
}

/** Runs `task` holding the store lock, waiting for it within the deploy bound. */
export async function withRuntimeStoreLock<T>(
  conn: SshConnection,
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

/** Runs `task` only when the lock is free now; null when another holder has it. */
export async function tryWithRuntimeStoreLock<T>(
  conn: SshConnection,
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
