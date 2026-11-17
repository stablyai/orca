import type { RemoteInstallTransport } from './remote-install-transport'
import { execHostCommand } from '../../ssh/remote-exec/remote-host-exec'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import type { RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import {
  tryStealInstallLockCommand,
  type InstallLockOwnerFile
} from './remote-install-lock-commands'
import {
  installLockHolderExitedProbeCommand,
  parseInstallLockHolderExit,
  type InstallLockHolderExit
} from './remote-install-lock-holder-commands'

/** A contender's view of a flock-backed lock across probes; one per acquire attempt. */
export type HolderTakeoverState = { gone: InstallLockHolderExit | null }

async function answered(work: Promise<string>, fallback: string): Promise<string> {
  try {
    return await work
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return fallback
  }
}

/** Steal output once the same lock generation read gone on two probes, else null. The steal
 * itself rechecks under its mutex with the holder file exclusively locked. */
export async function tryTakeOverExitedHolder(
  conn: RemoteInstallTransport,
  host: RemoteHostPlatform,
  lockDir: string,
  owner: InstallLockOwnerFile,
  state: HolderTakeoverState,
  staleAfterSeconds: number,
  signal?: AbortSignal
): Promise<string | null> {
  const seen = parseInstallLockHolderExit(
    await answered(
      execHostCommand(conn, host, installLockHolderExitedProbeCommand(lockDir, owner.fileName), {
        signal
      }),
      ''
    )
  )
  const confirmed =
    seen !== null && state.gone?.dirKey === seen.dirKey && state.gone.token === seen.token
  state.gone = seen
  if (!confirmed) {
    return null
  }
  const steal = await answered(
    execHostCommand(
      conn,
      host,
      tryStealInstallLockCommand(host, lockDir, staleAfterSeconds, owner, undefined, seen),
      { signal }
    ),
    'BUSY'
  )
  signal?.throwIfAborted()
  if (steal.trim().endsWith('OK')) {
    state.gone = null
    return steal
  }
  return null
}
