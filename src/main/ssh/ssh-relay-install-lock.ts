import type { SshConnection } from './ssh-connection'
import { execHostCommand } from './ssh-relay-host-exec'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { isRelayGcClaimed, waitForRelayGcClaimRelease } from './ssh-relay-gc-claim'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand,
  type InstallLockOwnerFile
} from './ssh-relay-install-lock-commands'
import type { InstallLockExitedOwner } from './ssh-relay-install-lock-exited-owner'
import {
  getRemoteHostPlatform,
  joinRemotePath,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'

export { RELAY_INSTALL_LOCK_NAME }

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

export class RemoteInstallLockBusyError extends Error {
  constructor(lockDir: string, timeoutMs: number) {
    super(
      `Could not acquire relay install lock at ${lockDir} after ${timeoutMs / 1000}s; ` +
        'another install is still in progress.'
    )
    this.name = 'RemoteInstallLockBusyError'
  }
}

// Why: an unconfirmed termination may have run remotely, so it never becomes a fallback.
async function unlessUnconfirmed<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return fallback
  }
}

export async function isRelayInstallLockStale(
  conn: SshConnection,
  lockDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  // Why: remote time avoids clock skew between Orca clients making a live
  // repair lock look old enough for GC or another installer to recover.
  const out = await unlessUnconfirmed(
    execHostCommand(conn, host, lockAgeSecondsCommand(host, lockDir)),
    ''
  )
  const ageSec = Number.parseInt(out.trim(), 10)
  return Number.isFinite(ageSec) && ageSec >= 0 && ageSec * 1000 > INSTALL_LOCK_STALE_MS
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
  options?: {
    signal?: AbortSignal
    lockName?: string
    /** False for a lock whose directory is not a relay version dir, so no GC claim can name it. */
    relayGcClaim?: boolean
    /** False when a held lock is a fence whose age cannot prove its owner's work is finished. */
    allowStaleTakeover?: boolean
    waitTimeoutMs?: number
    /** Written in the command that creates the lock, so a holder can prove the lock its own. */
    owner?: InstallLockOwnerFile
    /** Names a held lock's owner token this caller proved exited, so the steal may take it early. */
    exitedOwner?: InstallLockExitedOwnerProof
  }
): Promise<void> {
  const lockDir = joinRemotePath(host, remoteRelayDir, options?.lockName ?? RELAY_INSTALL_LOCK_NAME)
  const waitTimeoutMs = options?.waitTimeoutMs ?? INSTALL_LOCK_TIMEOUT_MS
  if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error('Install lock wait timeout must be a non-negative integer.')
  }
  const relayGcClaim = options?.relayGcClaim ?? true
  const isClaimed = (): Promise<boolean> =>
    relayGcClaim
      ? isRelayGcClaimed(conn, remoteRelayDir, host, options?.signal)
      : Promise.resolve(false)
  // Why: GC may claim the sibling path between our probe and taking the lock.
  // Recheck while holding the in-tree lock; one side backs off.
  const keptAfterGcRecheck = async (): Promise<boolean> => {
    if (!(await unlessUnconfirmed(isClaimed(), true)) && !options?.signal?.aborted) {
      return true
    }
    await unlessUnconfirmed(execHostCommand(conn, host, removeRemoteTreeCommand(host, lockDir)), '')
    options?.signal?.throwIfAborted()
    return false
  }

  const start = Date.now()
  // Busy means a holder answered; a lock command that only ever failed reports its own error.
  let sawHolder = false
  let lastCommandError: unknown
  let lastStaleCheckAt = Number.NEGATIVE_INFINITY
  let lastWaitLogAt = Number.NEGATIVE_INFINITY
  while (true) {
    // Why: a crashed GC can leave the stable sibling claim behind. The shared
    // waiter recovers stale claims instead of polling that orphan forever.
    if (relayGcClaim) {
      await waitForRelayGcClaimRelease(conn, remoteRelayDir, host, options?.signal)
    }
    options?.signal?.throwIfAborted()
    await execHostCommand(conn, host, acquireInstallLockParentCommand(host, remoteRelayDir), {
      signal: options?.signal
    })
    try {
      const createCommand = tryCreateInstallLockCommand(host, lockDir, options?.owner)
      const result = await execHostCommand(conn, host, createCommand, {
        signal: options?.signal
      })
      if (result.trim().endsWith('OK') && (await keptAfterGcRecheck())) {
        return
      }
      sawHolder = true
    } catch (err) {
      if (isUnconfirmedSshCommandTermination(err)) {
        throw err
      }
      options?.signal?.throwIfAborted()
      // Retried until the bounded wait expires: one refused channel is not a verdict.
      lastCommandError = err
    }
    if (
      options?.allowStaleTakeover !== false &&
      Date.now() - lastStaleCheckAt >= INSTALL_LOCK_STALE_RECHECK_MS
    ) {
      lastStaleCheckAt = Date.now()
      const exitedOwner = await exitedOwnerFor(lockDir, options)
      // Why: recover an already-stale lock immediately, then keep checking in
      // case a fresh holder crosses the stale threshold while we are waiting.
      const steal = await unlessUnconfirmed(
        execHostCommand(
          conn,
          host,
          tryStealInstallLockCommand(
            host,
            lockDir,
            INSTALL_LOCK_STALE_SECONDS,
            options?.owner,
            exitedOwner
          ),
          { signal: options?.signal }
        ),
        'BUSY'
      )
      options?.signal?.throwIfAborted()
      if (steal.trim().endsWith('OK')) {
        const reason = steal.trim().endsWith('REBOOT_OK')
          ? 'previous-boot'
          : steal.trim().endsWith('EXITED_OWNER_OK')
            ? 'exited-owner'
            : 'stale'
        if (exitedOwner && reason === 'exited-owner') {
          options?.exitedOwner?.reclaimed(exitedOwner.token)
        }
        console.warn(`[ssh-relay] Stealing ${reason} install lock at ${lockDir}`)
        if (await keptAfterGcRecheck()) {
          return
        }
      }
    }
    if (Date.now() - lastWaitLogAt >= INSTALL_LOCK_STALE_RECHECK_MS) {
      lastWaitLogAt = Date.now()
      console.info(`[ssh-relay] Waiting for install lock at ${lockDir}`)
    }
    if (Date.now() - start >= waitTimeoutMs) {
      if (!sawHolder && lastCommandError !== undefined) {
        throw lastCommandError
      }
      throw new RemoteInstallLockBusyError(lockDir, waitTimeoutMs)
    }
    await waitForInstallLockPoll(options?.signal)
  }
}

export type InstallLockExitedOwnerProof = {
  /** The token a provably exited holder wrote into `lockDir`, or null when none is proven. */
  find(lockDir: string): Promise<string | null>
  reclaimed(token: string): void
  quietSeconds: number
  /** Held by the steal across the takeover, so no mutation is admitted under the old owner. */
  mutationLock?: string
}

async function exitedOwnerFor(
  lockDir: string,
  options: { owner?: InstallLockOwnerFile; exitedOwner?: InstallLockExitedOwnerProof } | undefined
): Promise<InstallLockExitedOwner | undefined> {
  const proof = options?.exitedOwner
  if (!proof || !options?.owner) {
    return undefined
  }
  const token = await proof.find(lockDir)
  return token === null
    ? undefined
    : {
        fileName: options.owner.fileName,
        token,
        quietSeconds: proof.quietSeconds,
        mutationLock: proof.mutationLock
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
