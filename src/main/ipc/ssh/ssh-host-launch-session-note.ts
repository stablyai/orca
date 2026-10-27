/** Flag macOS managed servers that outlive their launching SSH session. */
import { getAppEnvironment } from '../../../shared/app-environment'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { readManagedOrcadLaunchSshSession } from '../../managed-server/lifecycle/orcad-managed-launch-session'
import { knownSshHostPlatform } from '../../ssh/ssh-host-platform-memo'
import { getSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { connectionManager } from './ssh-ipc-context'
import {
  clearLaunchSessionNote,
  publishHostServerStatus
} from '../runtime-environments/runtime-environment-managed-tunnel'

// Restores run on every runtime call; cache only within the same environment and SSH session.
const checked = new WeakMap<
  object,
  { environmentId: string; generation: number; ended: boolean; at: number }
>()
const RECHECK_MS = 10 * 60_000

/** Report only proven launch-session exits; probe failures must not fail callers. */
export async function noteEndedLaunchSshSession(
  targetId: string,
  environmentId: string,
  now: () => number = Date.now
): Promise<void> {
  // Tunnel setup caches platform, avoiding extra Linux/Windows round trips.
  if (knownSshHostPlatform(targetId)?.os !== 'darwin') {
    return
  }
  const connection = connectionManager?.getConnection(targetId)
  if (!connection) {
    return
  }
  const generation = connection.getConnectGeneration()
  const prior = checked.get(connection)
  const sameSession = prior?.generation === generation && prior.environmentId === environmentId
  if (sameSession && now() - prior.at < RECHECK_MS) {
    if (prior.ended) {
      flag(targetId, environmentId)
    }
    return
  }
  const pending = { environmentId, generation, ended: false, at: now() }
  checked.set(connection, pending)
  // Only a live probe disproves a proven end; unanswered or unknown keeps it.
  const provenEnded = sameSession && prior.ended
  const markEnded = (): void => {
    checked.set(connection, { environmentId, generation, ended: true, at: now() })
    flag(targetId, environmentId)
  }
  // Disconnect, reconnect, unlink or relaunch during probing invalidates the answer.
  const stale = (): boolean =>
    connectionManager?.getConnection(targetId) !== connection ||
    connection.getConnectGeneration() !== generation ||
    checked.get(connection) !== pending
  try {
    const session = await readManagedOrcadLaunchSshSession(
      getAppEnvironment().getPath('userData'),
      environmentId
    )
    if (stale()) {
      return
    }
    const status = getSshHostServerStatus(targetId)
    if (status?.kind === 'setting-up') {
      // A start or update is still deciding; a later call checks again.
      checked.delete(connection)
      return
    }
    if (session === 'exited' || (session !== 'live' && provenEnded)) {
      markEnded()
    } else if (session === 'live' && launchSessionNoted(targetId, environmentId)) {
      clearLaunchSessionNote(targetId, environmentId)
    }
  } catch (error) {
    if (provenEnded && !stale()) {
      markEnded()
    }
    console.warn('[ssh] Could not check which SSH session started the managed server:', error)
  }
}

function launchSessionNoted(targetId: string, environmentId: string): boolean {
  const status = getSshHostServerStatus(targetId)
  return (
    status?.kind === 'managed' &&
    status.environmentId === environmentId &&
    status.launchSessionEnded === true
  )
}

/** Restored hosts may lack status; preserve any conflicting server decision. */
function flag(targetId: string, environmentId: string): void {
  const userDataPath = getAppEnvironment().getPath('userData')
  if (!listEnvironments(userDataPath).some((entry) => entry.id === environmentId)) {
    return
  }
  const status = getSshHostServerStatus(targetId)
  if (
    !status ||
    (status.kind === 'managed' &&
      status.environmentId === environmentId &&
      !status.serving &&
      !status.launchSessionEnded)
  ) {
    publishHostServerStatus(targetId, {
      ...(status ?? { kind: 'managed', environmentId }),
      launchSessionEnded: true
    })
  }
}

/** Verified restart or relaunch invalidates the cached launch-session verdict. */
export function forgetLaunchSessionVerdict(targetId: string): void {
  const connection = connectionManager?.getConnection(targetId)
  if (connection) {
    checked.delete(connection)
  }
}
