import type { SshConnection } from './ssh-connection'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { RELAY_INSTALL_LOCK_NAME, acquireInstallLock } from './ssh-relay-install-lock'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from './orcad-activation-transaction'

const ORCAD_ACTIVATION_MAX_READINESS_TIMEOUT_MS = 5 * 60_000

type OrcadActivationLockOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

export type OrcadActivationLockControl = {
  retainOnError(): void
  retain(): void
}

export function orcadActivationTransactionRoot(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
}

export function orcadActivationLockPath(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(
    host,
    orcadActivationTransactionRoot(host, remoteHome),
    RELAY_INSTALL_LOCK_NAME
  )
}

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

/** Serialize every stop/snapshot/start/record transaction for one remote host. */
export async function withOrcadActivationLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: OrcadActivationLockControl) => Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    // A retained activation fence means state ownership is unresolved. Age cannot make it safe.
    allowStaleTakeover: false
  })
  const release = (): Promise<void> => releaseActivationTransaction(options, lockRoot)

  let retainOnError = false
  let retain = false
  try {
    const result = await run({
      retainOnError: () => {
        retainOnError = true
      },
      retain: () => {
        retain = true
      }
    })
    if (!retain) {
      await release()
    }
    return result
  } catch (error) {
    // A remote mutation whose teardown is unconfirmed keeps its manually recoverable fence.
    if (!retainOnError && !isUnconfirmedSshCommandTermination(error)) {
      await release().catch((releaseError) => {
        console.warn(
          `[orcad] Failed to release activation lock after an error: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
        )
      })
    }
    throw error
  }
}

export async function withStaleOrcadActivationRecoveryLock<T>(
  options: OrcadActivationLockOptions,
  run: (control: Pick<OrcadActivationLockControl, 'retain'>) => Promise<T>
): Promise<T> {
  const lockRoot = orcadActivationTransactionRoot(options.host, options.remoteHome)
  await acquireInstallLock(options.conn, lockRoot, options.host, {
    signal: options.signal,
    allowStaleTakeover: true,
    waitTimeoutMs: 0
  })
  let retain = false
  const result = await run({ retain: () => (retain = true) })
  if (!retain) {
    await releaseActivationTransaction(options, lockRoot)
  }
  return result
}

function releaseActivationTransaction(
  options: OrcadActivationLockOptions,
  lockRoot: string
): Promise<void> {
  return execCommand(options.conn, removeRemoteTreeCommand(options.host, lockRoot), {
    wrapCommand: options.host.commandDialect !== 'powershell'
  }).then(() => undefined)
}
