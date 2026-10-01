/**
 * One activation or rollback per host, and the fence an interrupted one leaves behind.
 *
 * The lock lives in the transaction root, so releasing it also removes the journal. A run
 * that cannot prove the host is back to one serving slot retains both; only recovery, after
 * the install lock's stale window, may take a retained fence over.
 */
import {
  execOrcadRemote,
  withoutAbortSignal,
  type OrcadRemoteExecTarget
} from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { acquireInstallLock, RELAY_INSTALL_LOCK_NAME } from './ssh-relay-install-lock'
import { probeInstallLockExistsCommand } from './ssh-relay-install-lock-commands'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { removeRemoteFileCommand, removeRemoteTreeCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME
} from './orcad-activation-transaction'

const ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

type OrcadActivationLockOptions = OrcadRemoteExecTarget & { remoteHome: string }

export type OrcadActivationLockControl = {
  /** Keep the fence if the run throws: a journal now describes host state. */
  retainOnError(): void
  /** Keep the fence even on return: the host is not proven back to one serving slot. */
  retain(): void
  /** The host is proven back on its recorded slot: release even if the run then throws. */
  recovered(): void
}

export function orcadActivationTransactionRoot(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
}

/** Bounded so a crashed holder's lock goes stale long before a live holder could still be waiting. */
export function resolveOrcadActivationReadinessTimeout(
  configured: number | undefined,
  fallback: number
): number {
  const timeout = configured ?? fallback
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS
  ) {
    throw new Error(
      `orcad readiness timeout must be an integer from 1 to ${ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS}ms`
    )
  }
  return timeout
}

export async function withOrcadActivationLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: OrcadActivationLockControl) => Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    // A retained fence means state ownership is unresolved. Age cannot make it safe.
    allowStaleTakeover: false
  })
  let retainOnError = false
  let retain = false
  try {
    const result = await run({
      retainOnError: () => {
        retainOnError = true
      },
      retain: () => {
        retain = true
      },
      recovered: () => {
        retainOnError = false
      }
    })
    if (!retain) {
      await releaseActivationFence(options, lockRoot)
    }
    return result
  } catch (error) {
    // A remote mutation whose teardown is unconfirmed may still be running: keep its fence.
    if (!retainOnError && !isUnconfirmedSshCommandTermination(error)) {
      await releaseActivationFence(options, lockRoot).catch((releaseError: unknown) => {
        console.warn(
          `[orcad] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

/** Takes over only a stale or previous-boot fence; a fresh one throws `RemoteInstallLockBusyError`. */
export async function withStaleOrcadActivationRecoveryLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: Pick<OrcadActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    relayGcClaim: false,
    allowStaleTakeover: true,
    waitTimeoutMs: 0
  })
  let retain = false
  // Any throw keeps the fence: recovery failed to prove one serving slot.
  const result = await run({ retain: () => (retain = true) })
  if (!retain) {
    await releaseActivationFence(options, lockRoot)
  }
  return result
}

/** Whether any lock is held; a lost probe throws rather than reading as open. */
export async function orcadActivationFenceExists(
  options: OrcadActivationLockOptions
): Promise<boolean> {
  const lockDir = joinRemotePath(
    options.host,
    orcadActivationTransactionRoot(options.host, options.remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
  const answer = (
    await execOrcadRemote(options, probeInstallLockExistsCommand(options.host, lockDir))
  ).trim()
  if (answer !== 'LOCKED' && answer !== 'OPEN') {
    throw new Error('The activation fence probe returned no verifiable answer.')
  }
  return answer === 'LOCKED'
}

function releaseActivationFence(
  options: OrcadActivationLockOptions,
  lockRoot: string
): Promise<void> {
  // Journal first: a release cut short must leave a lock without a journal, never the reverse.
  const journal = joinRemotePath(options.host, lockRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME)
  // Why no signal: a cancelled run must still be able to drop a fence it proved unnecessary.
  return execOrcadRemote(
    withoutAbortSignal(options),
    `${removeRemoteFileCommand(options.host, journal)} && ${removeRemoteTreeCommand(options.host, lockRoot)}`
  ).then(() => undefined)
}
