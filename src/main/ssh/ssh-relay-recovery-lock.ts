// Per-socket advisory lock that serializes orphan recovery across Orca instances.
//
// The relay directory's install lock and GC claim are keyed per relay *version*, but two Orca
// targets share that directory while owning different sockets — and the same target can be open
// from two machines. Recovery therefore needs its own key: the socket path. The remote primitive is
// the proven mkdir-plus-owner-token lock from ssh-relay-install-lock-commands.

import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './ssh-relay-install-lock-commands'
import { waitForRelayPollDelay } from './ssh-relay-poll-delay'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

const RECOVERY_LOCK_SUFFIX = '.recovery-lock'
const RECOVERY_LOCK_OWNER_NAME = '.owner'
const RECOVERY_LOCK_RETRY_MS = 1_000
// Why: the holder releases in a `finally` that survives abort, so a lock outliving this window means
// the holding client died outright. The window must still exceed the worst-case hold — every remote
// probe timing out through the exit wait and one launch poll — or two clients could reap at once.
const RECOVERY_LOCK_STALE_SECONDS = 20 * 60
// Why: the release runs after an abort, so it cannot inherit the aborted signal; bound it instead.
const RECOVERY_LOCK_RELEASE_TIMEOUT_MS = 15_000
const RECOVERY_LOCK_EXEC_TIMEOUT_MS = 15_000
export const RELAY_RECOVERY_LOCK_MAX_ATTEMPTS = 30

export function relayRecoveryLockPath(sockPath: string): string {
  return `${sockPath}${RECOVERY_LOCK_SUFFIX}`
}

/**
 * Returns the held lock, or null when it stayed held for the whole window. `waited` marks a caller
 * that queued behind a peer — only that caller needs to re-check what the peer already changed.
 */
export type RelayRecoveryLock = { token: string; waited: boolean }

export async function acquireRelayRecoveryLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<RelayRecoveryLock | null> {
  const lockPath = relayRecoveryLockPath(sockPath)
  for (let attempt = 0; attempt < RELAY_RECOVERY_LOCK_MAX_ATTEMPTS; attempt++) {
    const created = await exec(conn, host, tryCreateInstallLockCommand(host, lockPath), signal)
    if (created.trim().endsWith('OK')) {
      return {
        token: await writeRecoveryLockOwner(conn, host, sockPath, signal),
        waited: attempt > 0
      }
    }
    const stolen = await exec(
      conn,
      host,
      tryStealInstallLockCommand(host, lockPath, RECOVERY_LOCK_STALE_SECONDS),
      signal
    )
    if (stolen.trim().endsWith('OK')) {
      return { token: await writeRecoveryLockOwner(conn, host, sockPath, signal), waited: true }
    }
    await waitForRelayPollDelay(RECOVERY_LOCK_RETRY_MS, signal)
  }
  return null
}

export async function releaseRelayRecoveryLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  token: string
): Promise<void> {
  const lockPath = relayRecoveryLockPath(sockPath)
  const ownerPath = joinRemotePath(host, lockPath, RECOVERY_LOCK_OWNER_NAME)
  // Why: conditional on our token, so a lock a successor already stole is never removed by us.
  const command = [
    `if ! [ -e ${shellEscape(lockPath)} ]; then echo RELEASED;`,
    // Why: a lock directory with no owner file was never claimed by anyone — most likely ours, from
    // a create that succeeded before the owner write lost its reply. Leaving it would block every
    // client for the whole staleness window, so reclaim it rather than report it lost.
    `elif [ ! -e ${shellEscape(ownerPath)} ]; then ${removeRemoteTreeCommand(host, lockPath)} 2>/dev/null; echo RELEASED;`,
    `elif [ "$(cat ${shellEscape(ownerPath)} 2>/dev/null)" != ${shellEscape(token)} ]; then echo LOST;`,
    `else ${removeRemoteTreeCommand(host, lockPath)} 2>/dev/null; echo RELEASED; fi`
  ].join(' ')
  await execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(host),
    timeoutMs: RECOVERY_LOCK_RELEASE_TIMEOUT_MS
  }).catch(() => 'UNKNOWN')
}

async function writeRecoveryLockOwner(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<string> {
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`
  const ownerPath = joinRemotePath(host, relayRecoveryLockPath(sockPath), RECOVERY_LOCK_OWNER_NAME)
  try {
    await exec(conn, host, `printf %s ${shellEscape(token)} > ${shellEscape(ownerPath)}`, signal)
    return token
  } catch (err) {
    // Why: the write may have landed before SSH lost the reply; drop our own generation rather than
    // hold a lock we cannot prove we own.
    await releaseRelayRecoveryLock(conn, host, sockPath, token).catch(() => undefined)
    throw err
  }
}

function exec(
  conn: SshConnection,
  host: RemoteHostPlatform,
  command: string,
  signal?: AbortSignal
): Promise<string> {
  // Why: every hop inside the lock hold must be bounded, or one wedged command stretches the hold
  // past the staleness window and lets a second client reap the same socket.
  return execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(host),
    timeoutMs: RECOVERY_LOCK_EXEC_TIMEOUT_MS,
    signal
  })
}
