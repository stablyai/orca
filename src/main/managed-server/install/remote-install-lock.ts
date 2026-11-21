import type { RemoteInstallTransport } from './remote-install-transport'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { REMOTE_INSTALL_TIMEOUT_MS } from './remote-deploy-timing'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { isRelayGcClaimed, waitForRelayGcClaimRelease } from './remote-install-gc-claim'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand,
  type InstallLockOwnerFile
} from './remote-install-lock-commands'
import type { InstallLockExitedOwner } from './remote-install-lock-exited-owner'
import {
  tryTakeOverExitedHolder,
  type HolderTakeoverState
} from './remote-install-lock-holder-takeover'
import {
  getRemoteHostPlatform,
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'
import { removeRemoteTreeCommand } from '../../ssh/remote-exec/ssh-remote-commands'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/remote-runtime/relay/relay-install-lock-name'

const INSTALL_LOCK_POLL_MS = 1_000
// Fresh locks may become stale during our wait; infrequent rechecks permit recovery without an exec per poll.
const INSTALL_LOCK_STALE_RECHECK_MS = 60_000
// Give holders at least one full install step before the waiter gives up.
const INSTALL_LOCK_TIMEOUT_MS = REMOTE_INSTALL_TIMEOUT_MS
// A gone holder must read gone twice this far apart before takeover.
const INSTALL_LOCK_HOLDER_PROBE_MS = 5_000
// A holder's step may outlive its timeout; leave room before takeover.
export const INSTALL_LOCK_STALE_MS = 20 * 60_000
export const INSTALL_LOCK_STALE_SECONDS = INSTALL_LOCK_STALE_MS / 1000
const DEFAULT_REMOTE_HOST = getRemoteHostPlatform('linux-x64')

export class RemoteInstallLockBusyError extends Error {
  constructor(lockDir: string, timeoutMs: number) {
    super(
      `Could not acquire the install lock at ${lockDir} after ${Math.round(timeoutMs / 1000)}s; ` +
        'another install is still in progress.'
    )
    this.name = 'RemoteInstallLockBusyError'
  }
}

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

/** Null when the host did not answer with an age. */
async function readInstallLockAgeMs(
  conn: RemoteInstallTransport,
  lockDir: string,
  host: RemoteHostPlatform,
  signal?: AbortSignal
): Promise<number | null> {
  // Measure remotely to avoid client clock skew making live locks look stale.
  const out = await unlessUnconfirmed(
    execHostCommand(conn, host, lockAgeSecondsCommand(host, lockDir), { signal }),
    ''
  )
  const ageSec = Number.parseInt(out.trim(), 10)
  return Number.isFinite(ageSec) && ageSec >= 0 ? ageSec * 1000 : null
}

export async function isRelayInstallLockStale(
  conn: RemoteInstallTransport,
  lockDir: string,
  host: RemoteHostPlatform = DEFAULT_REMOTE_HOST
): Promise<boolean> {
  const ageMs = await readInstallLockAgeMs(conn, lockDir, host)
  return ageMs !== null && ageMs > INSTALL_LOCK_STALE_MS
}

/** A held lock's wait; `takeoverInMs` is null when no takeover is due before this attempt gives up.
 * `holderGone`: a flock-backed lock whose holder exited, taken over within seconds. */
export type InstallLockWait = {
  takeoverInMs: number | null
  givesUpInMs: number
  holderGone?: boolean
}

/** Exclusive host-native creation preserves lock markers older Windows clients recognize. */
export async function acquireInstallLock(
  conn: RemoteInstallTransport,
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
    /** Atomic owner writes let holders prove continued ownership. */
    owner?: InstallLockOwnerFile
    /** Proven-exited owner token permits early takeover. */
    exitedOwner?: InstallLockExitedOwnerProof
    /** Keep waiting until the held lock turns stale rather than timing out just before takeover. */
    waitThroughStaleTakeover?: boolean
    /** Reported at each stale recheck while another holder keeps the lock. */
    onWait?: (wait: InstallLockWait) => void
    /** POSIX: take over a flock-backed lock whose holder and fenced commands are all gone. */
    probeExitedHolder?: boolean
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
  // GC can claim between our probe and lock acquisition; recheck under the lock so one side backs off.
  const keptAfterGcRecheck = async (): Promise<boolean> => {
    if (!(await unlessUnconfirmed(isClaimed(), true)) && !options?.signal?.aborted) {
      return true
    }
    await unlessUnconfirmed(execHostCommand(conn, host, removeRemoteTreeCommand(host, lockDir)), '')
    options?.signal?.throwIfAborted()
    return false
  }

  const start = Date.now()
  let deadline = start + waitTimeoutMs
  // Busy means a holder answered; a lock command that only ever failed reports its own error.
  let sawHolder = false
  let lastCommandError: unknown
  let lastStaleCheckAt = Number.NEGATIVE_INFINITY
  let lastWaitLogAt = Number.NEGATIVE_INFINITY
  let lastHolderProbeAt = Number.NEGATIVE_INFINITY
  const holderTakeover: HolderTakeoverState = { gone: null }
  const probedOwner =
    options?.probeExitedHolder && !isWindowsRemoteHost(host) ? options.owner : undefined
  let reportedHolderGone = false
  // Age as last read, so a probe-driven report can still count down to the stale takeover.
  let lastAge: { ms: number; at: number } | null = null
  // A holder read gone means takeover in seconds, not at the lock's stale age.
  const reportWait = (): void => {
    reportedHolderGone = holderTakeover.gone !== null
    const ageMs = lastAge === null ? null : lastAge.ms + (Date.now() - lastAge.at)
    const takeoverInMs = reportedHolderGone
      ? INSTALL_LOCK_HOLDER_PROBE_MS
      : ageMs === null
        ? null
        : Math.max(0, INSTALL_LOCK_STALE_MS - ageMs)
    // Capped so a holder that keeps refreshing the lock cannot extend the wait forever.
    const cap = start + INSTALL_LOCK_STALE_MS + 2 * INSTALL_LOCK_STALE_RECHECK_MS
    if (options?.waitThroughStaleTakeover && takeoverInMs !== null) {
      // Lock age, not this attempt, sets the takeover time; a relaunch waits only the rest.
      deadline = Math.max(
        deadline,
        Math.min(Date.now() + takeoverInMs + INSTALL_LOCK_STALE_RECHECK_MS, cap)
      )
    }
    const now = Date.now()
    // Promise a takeover only if this attempt is still waiting when it comes due.
    options?.onWait?.({
      takeoverInMs: takeoverInMs !== null && now + takeoverInMs < deadline ? takeoverInMs : null,
      givesUpInMs: Math.max(0, deadline - now),
      ...(reportedHolderGone ? { holderGone: true } : {})
    })
  }
  while (true) {
    // Recover crashed GC claims rather than polling them forever.
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
    if (probedOwner && Date.now() - lastHolderProbeAt >= INSTALL_LOCK_HOLDER_PROBE_MS) {
      lastHolderProbeAt = Date.now()
      const steal = await tryTakeOverExitedHolder(
        conn,
        host,
        lockDir,
        probedOwner,
        holderTakeover,
        INSTALL_LOCK_STALE_SECONDS,
        options?.signal
      )
      if (steal) {
        console.warn(`[ssh] Stealing ${stealReason(steal)} install lock at ${lockDir}`)
        if (await keptAfterGcRecheck()) {
          return
        }
      }
      // After the first age report, every probe that flips the holder's state is reported at once.
      if (
        (holderTakeover.gone !== null) !== reportedHolderGone &&
        Number.isFinite(lastStaleCheckAt) &&
        (options?.onWait || options?.waitThroughStaleTakeover)
      ) {
        reportWait()
      }
    }
    if (
      options?.allowStaleTakeover !== false &&
      Date.now() - lastStaleCheckAt >= INSTALL_LOCK_STALE_RECHECK_MS
    ) {
      lastStaleCheckAt = Date.now()
      const exitedOwner = await exitedOwnerFor(lockDir, options)
      // Recover stale locks immediately, then recheck as fresh locks age.
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
        const reason = stealReason(steal)
        if (exitedOwner && reason === 'exited-owner') {
          options?.exitedOwner?.reclaimed(exitedOwner.token)
        }
        console.warn(`[ssh] Stealing ${reason} install lock at ${lockDir}`)
        if (await keptAfterGcRecheck()) {
          return
        }
      } else if (options?.onWait || options?.waitThroughStaleTakeover) {
        const ageMs = await readInstallLockAgeMs(conn, lockDir, host, options.signal)
        lastAge = ageMs === null ? null : { ms: ageMs, at: Date.now() }
        reportWait()
      }
    }
    if (Date.now() - lastWaitLogAt >= INSTALL_LOCK_STALE_RECHECK_MS) {
      lastWaitLogAt = Date.now()
      console.info(`[ssh] Waiting for install lock at ${lockDir}`)
    }
    if (Date.now() >= deadline) {
      if (!sawHolder && lastCommandError !== undefined) {
        throw lastCommandError
      }
      throw new RemoteInstallLockBusyError(lockDir, deadline - start)
    }
    await waitForInstallLockPoll(options?.signal)
  }
}

function stealReason(steal: string): string {
  const result = steal.trim()
  if (result.endsWith('REBOOT_OK')) {
    return 'previous-boot'
  }
  if (result.endsWith('EXITED_OWNER_OK')) {
    return 'exited-owner'
  }
  return result.endsWith('HOLDER_EXITED_OK') ? 'exited-holder' : 'stale'
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
