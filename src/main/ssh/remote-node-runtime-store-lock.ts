/**
 * The `runtimes/` store's mkdir lock (design D5). Promotion waits for it; store GC only tries it,
 * so a collector never queues behind an install. Both use the install lock's primitives and its
 * 20-minute stale rule.
 */
import { ORCAD_RUNTIMES_DIRNAME } from '../../shared/orcad-artifacts'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { acquireInstallLock, INSTALL_LOCK_STALE_SECONDS } from './ssh-relay-install-lock'
import {
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export const RUNTIME_STORE_LOCK_NAME = '.store-lock'

export function remoteNodeRuntimeStoreDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_RUNTIMES_DIRNAME)
}

function lockDir(host: RemoteHostPlatform, storeDir: string): string {
  return joinRemotePath(host, storeDir, RUNTIME_STORE_LOCK_NAME)
}

async function releaseRuntimeStoreLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string
): Promise<void> {
  await execCommand(conn, removeRemoteTreeCommand(host, lockDir(host, storeDir)), {
    wrapCommand: !isWindowsRemoteHost(host)
  }).catch((error) => {
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
  signal?: AbortSignal
): Promise<boolean> {
  const lock = lockDir(host, storeDir)
  try {
    // Why unwrapped on Windows: these are already self-contained powershell.exe command lines.
    const wrapCommand = !isWindowsRemoteHost(host)
    const created = await execCommand(conn, tryCreateInstallLockCommand(host, lock), {
      signal,
      wrapCommand
    })
    if (created.trim().endsWith('OK')) {
      return true
    }
    const stolen = await execCommand(
      conn,
      tryStealInstallLockCommand(host, lock, INSTALL_LOCK_STALE_SECONDS),
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

async function runHoldingLock<T>(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  task: () => Promise<T>
): Promise<T> {
  let value: T
  try {
    value = await task()
  } catch (error) {
    // Why keep it on an unconfirmed termination: the remote step may still be running.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await releaseRuntimeStoreLock(conn, host, storeDir)
    }
    throw error
  }
  await releaseRuntimeStoreLock(conn, host, storeDir)
  return value
}

/** Runs `task` holding the store lock, waiting for it within the deploy bound. */
export async function withRuntimeStoreLock<T>(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  await acquireInstallLock(conn, storeDir, host, {
    signal,
    lockName: RUNTIME_STORE_LOCK_NAME,
    relayGcClaim: false
  })
  return runHoldingLock(conn, host, storeDir, task)
}

/** Runs `task` only when the lock is free now; null when another holder has it. */
export async function tryWithRuntimeStoreLock<T>(
  conn: SshConnection,
  host: RemoteHostPlatform,
  storeDir: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<{ value: T } | null> {
  if (!(await tryAcquireRuntimeStoreLock(conn, host, storeDir, signal))) {
    return null
  }
  return { value: await runHoldingLock(conn, host, storeDir, task) }
}
