import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { isRelayGcClaimed, waitForRelayGcClaimRelease } from './ssh-relay-gc-claim'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import {
  getRemoteHostPlatform,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { removeRemoteTreeCommand } from './ssh-remote-commands'

export const RELAY_INSTALL_LOCK_NAME = '.install-lock'

const INSTALL_LOCK_POLL_MS = 1_000
// Why: a fresh lock can cross the stale threshold during our bounded wait.
// Recheck infrequently so it becomes recoverable without adding an exec per poll.
const INSTALL_LOCK_STALE_RECHECK_MS = 60_000
// Why: the lock holder can legitimately use the full deploy bound for upload,
// native install/rebuild, probes, and finalization. A concurrent first install
// must not fail earlier; completed-relay repair uses a separate one-shot path.
const INSTALL_LOCK_TIMEOUT_MS = RELAY_DEPLOY_TIMEOUT_MS
// Why: native-deps repair can keep running after the deploy backstop wins its
// Promise.race, so stale takeover must leave room for that bounded work.
export const INSTALL_LOCK_STALE_MS = 20 * 60_000
export const INSTALL_LOCK_STALE_SECONDS = INSTALL_LOCK_STALE_MS / 1000
const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

function execHostCommand(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  options?: { signal?: AbortSignal }
): Promise<string> {
  return execCommand(conn, command, {
    wrapCommand: host.commandDialect !== 'powershell',
    signal: options?.signal
  })
}

export async function isRelayInstallLockStale(
  conn: SshConnection,
  lockDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  try {
    // Why: remote time avoids clock skew between Orca clients making a live
    // repair lock look old enough for GC or another installer to recover.
    const out = await execHostCommand(conn, host, lockAgeSecondsCommand(host, lockDir))
    const ageSec = Number.parseInt(out.trim(), 10)
    return Number.isFinite(ageSec) && ageSec >= 0 && ageSec * 1000 > INSTALL_LOCK_STALE_MS
  } catch {
    return false
  }
}

/**
 * Acquire the per-version install lock via a host-native exclusive create.
 * Why: POSIX mkdir and a Windows directory plus atomic owner file each give
 * one winner while keeping the marker visible to older Windows Orca clients.
 */
export async function acquireInstallLock(
  conn: SshConnection,
  remoteRelayDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST,
  options?: { signal?: AbortSignal }
): Promise<void> {
  const lockDir = joinRemotePath(host, remoteRelayDir, RELAY_INSTALL_LOCK_NAME)

  const start = Date.now()
  let lastStaleCheckAt = Number.NEGATIVE_INFINITY
  while (true) {
    // Why: a crashed GC can leave the stable sibling claim behind. The shared
    // waiter recovers stale claims instead of polling that orphan forever.
    await waitForRelayGcClaimRelease(conn, remoteRelayDir, host, options?.signal)
    options?.signal?.throwIfAborted()
    await execHostCommand(conn, host, acquireInstallLockParentCommand(host, remoteRelayDir), {
      signal: options?.signal
    })
    try {
      const result = await execHostCommand(conn, host, tryCreateInstallLockCommand(host, lockDir), {
        signal: options?.signal
      })
      if (result.trim().endsWith('OK')) {
        // Why: GC may claim the sibling path between our first probe and lock
        // creation. Recheck while holding the in-tree lock; one side backs off.
        const claimedAfterAcquire = await isRelayGcClaimed(
          conn,
          remoteRelayDir,
          host,
          options?.signal
        ).catch(() => true)
        if (!claimedAfterAcquire && !options?.signal?.aborted) {
          return
        }
        await execHostCommand(conn, host, removeRemoteTreeCommand(host, lockDir)).catch(() => {})
        options?.signal?.throwIfAborted()
      }
    } catch {
      options?.signal?.throwIfAborted()
      // A failed mkdir is lock contention; keep the connection-specific error
      // out of the user path until the bounded wait expires.
    }
    if (Date.now() - lastStaleCheckAt >= INSTALL_LOCK_STALE_RECHECK_MS) {
      lastStaleCheckAt = Date.now()
      // Why: recover an already-stale lock immediately, then keep checking in
      // case a fresh holder crosses the stale threshold while we are waiting.
      const steal = await execHostCommand(
        conn,
        host,
        tryStealInstallLockCommand(host, lockDir, INSTALL_LOCK_STALE_SECONDS),
        { signal: options?.signal }
      ).catch(() => 'BUSY')
      options?.signal?.throwIfAborted()
      if (steal.trim().endsWith('OK')) {
        console.warn(`[ssh-relay] Stealing stale install lock at ${lockDir}`)
        const claimedAfterSteal = await isRelayGcClaimed(
          conn,
          remoteRelayDir,
          host,
          options?.signal
        ).catch(() => true)
        if (!claimedAfterSteal && !options?.signal?.aborted) {
          return
        }
        await execHostCommand(conn, host, removeRemoteTreeCommand(host, lockDir)).catch(() => {})
        options?.signal?.throwIfAborted()
      }
    }
    if (Date.now() - start >= INSTALL_LOCK_TIMEOUT_MS) {
      throw new Error(
        `Could not acquire relay install lock at ${lockDir} after ${
          INSTALL_LOCK_TIMEOUT_MS / 1000
        }s; another install is still in progress.`
      )
    }
    await waitForInstallLockPoll(options?.signal)
  }
}

function waitForInstallLockPoll(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', handleAbort)
      reject(signal?.reason)
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, INSTALL_LOCK_POLL_MS)
    signal?.addEventListener('abort', handleAbort, { once: true })
    if (signal?.aborted) {
      handleAbort()
    }
  })
}
