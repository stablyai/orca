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

/**
 * Claims the lock and publishes its owner token in ONE remote command.
 *
 * Why one command: with `mkdir` and the owner write as separate round trips, the lock exists
 * ownerless for a full trip. A peer that sees it cannot tell an abandoned claim from a successor
 * mid-publish, and a claimer that dies in the gap leaves a lock nobody can attribute. Emitting a
 * success verdict only after the owner file exists removes the observable window entirely.
 *
 * `CREATED` and `STOLEN` are distinct on purpose: a steal takes over from a holder that may already
 * have relaunched the relay before dying, so that caller must re-probe rather than reap what could
 * be a healthy successor.
 */
function acquireRecoveryLockCommand(
  host: RemoteHostPlatform,
  lockPath: string,
  token: string
): string {
  const ownerPath = joinRemotePath(host, lockPath, RECOVERY_LOCK_OWNER_NAME)
  // Why: a failed publication removes only the directory this command just created, which is
  // provably ours and milliseconds old — it can never be a peer's lock.
  const publish = (verdict: 'CREATED' | 'STOLEN'): string =>
    [
      `if printf %s ${shellEscape(token)} > ${shellEscape(ownerPath)} 2>/dev/null; then echo ${verdict};`,
      `else ${removeRemoteTreeCommand(host, lockPath)} 2>/dev/null; echo BUSY; fi`
    ].join(' ')
  // Why: both reused builders speak OK/BUSY, so capture each verdict instead of letting it reach
  // stdout — only the publication below may speak for this command. The capture also keeps the
  // steal's own `trap ... EXIT` cleanup firing when the substitution ends, exactly as before.
  return [
    `orca_claim=$(${tryCreateInstallLockCommand(host, lockPath)});`,
    `case "$orca_claim" in *OK) ${publish('CREATED')}; exit 0;; esac;`,
    `orca_claim=$(${tryStealInstallLockCommand(host, lockPath, RECOVERY_LOCK_STALE_SECONDS)});`,
    `case "$orca_claim" in *OK) ${publish('STOLEN')}; exit 0;; esac;`,
    'echo BUSY'
  ].join(' ')
}

export async function acquireRelayRecoveryLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  signal?: AbortSignal
): Promise<RelayRecoveryLock | null> {
  // Why: the POSIX glue below (`$( )`, `case`) has no PowerShell equivalent. Recovery already
  // refuses Windows hosts before reaching here (ssh-relay-generation-reap.ts), so this is a guard
  // against a future caller, not a reachable path.
  if (isWindowsRemoteHost(host)) {
    throw new Error('Relay recovery locking is POSIX-only; Windows relays are not recovered')
  }
  const lockPath = relayRecoveryLockPath(sockPath)
  const token = `${process.pid}-${Date.now()}-${randomUUID()}`
  const command = acquireRecoveryLockCommand(host, lockPath, token)
  for (let attempt = 0; attempt < RELAY_RECOVERY_LOCK_MAX_ATTEMPTS; attempt++) {
    let claimed: string
    try {
      claimed = await exec(conn, host, command, signal)
    } catch (err) {
      // Why: the verdict may have landed before SSH lost the reply. Release is conditional on our
      // token, so this drops only a lock we actually published and is a no-op otherwise.
      await releaseRelayRecoveryLock(conn, host, sockPath, token).catch(() => undefined)
      throw err
    }
    const verdict = lastLine(claimed)
    if (verdict === 'CREATED') {
      return { token, waited: attempt > 0 }
    }
    if (verdict === 'STOLEN') {
      return { token, waited: true }
    }
    await waitForRelayPollDelay(RECOVERY_LOCK_RETRY_MS, signal)
  }
  return null
}

export type RelayRecoveryLockRelease = 'released' | 'lost' | 'unknown'

export async function releaseRelayRecoveryLock(
  conn: SshConnection,
  host: RemoteHostPlatform,
  sockPath: string,
  token: string
): Promise<RelayRecoveryLockRelease> {
  const lockPath = relayRecoveryLockPath(sockPath)
  const ownerPath = joinRemotePath(host, lockPath, RECOVERY_LOCK_OWNER_NAME)
  // Why: conditional on our token, so a lock a successor already stole is never removed by us.
  const command = [
    `if ! [ -e ${shellEscape(lockPath)} ]; then echo RELEASED;`,
    // Why: an ownerless lock is a successor still publishing inside its own claim command, or a
    // claim whose shell died mid-publish. Neither is ours to delete — deleting it would hand two
    // clients the same socket. The staleness window reclaims the second case.
    `elif [ ! -f ${shellEscape(ownerPath)} ]; then echo LOST;`,
    `elif [ "$(cat ${shellEscape(ownerPath)} 2>/dev/null)" != ${shellEscape(token)} ]; then echo LOST;`,
    `else ${removeRemoteTreeCommand(host, lockPath)} 2>/dev/null; echo RELEASED; fi`
  ].join(' ')
  const output = await execCommand(conn, command, {
    wrapCommand: !isWindowsRemoteHost(host),
    timeoutMs: RECOVERY_LOCK_RELEASE_TIMEOUT_MS
  }).catch(() => 'UNKNOWN')
  const verdict = lastLine(output)
  if (verdict === 'RELEASED') {
    return 'released'
  }
  return verdict === 'LOST' ? 'lost' : 'unknown'
}

// Why the last line and not `endsWith`: the composed command captures the reused builders' own
// OK/BUSY output, but a login banner or a stray trailing byte would still make a substring test
// answer for us. Only the final line is ours.
function lastLine(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? ''
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
