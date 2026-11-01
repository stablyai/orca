import { getAppEnvironment } from '../../../shared/app-environment'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  clearSshUserDisconnected,
  clearSshUserDisconnectedForEnvironment,
  isSshUserDisconnected,
  recordSshUserDisconnected
} from '../../ssh/ssh-user-disconnect'
import {
  connectRegisteredSshTarget,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected,
  markRuntimeEnvironmentManuallyDisconnected
} from '../runtime-environments/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from '../runtime-environments/runtime-environment-request-connections'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'

/** Managed server and SSH host share user disconnect intent; only explicit Connect may restore either. */

type InvalidateTransport = (environmentId: string) => Promise<void> | void
type RuntimeLayer = { userDataPath: string; invalidateTransport: InvalidateTransport }

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

function environmentsReachedThrough(
  userDataPath: string,
  targetId: string
): KnownRuntimeEnvironment[] {
  return listEnvironments(userDataPath).filter(
    (environment) => getRuntimeSshAccess(environment)?.sshTargetId === targetId
  )
}

export function disconnectRuntimeEnvironmentForUser(
  environmentId: string,
  { userDataPath, invalidateTransport }: RuntimeLayer
): void {
  markRuntimeEnvironmentManuallyDisconnected(environmentId)
  void invalidateTransport(environmentId)
  // Retain disconnected evidence for renderers that missed the teardown event.
  getRuntimeEnvironmentStatusOwner(userDataPath, environmentId)
}

export async function disconnectSshHostForUser(
  targetId: string,
  runtimeLayer?: RuntimeLayer
): Promise<void> {
  // Fence status probes and reserve teardown synchronously so later Connect queues behind it.
  recordSshUserDisconnected(targetId)
  const userDataPath = runtimeLayer?.userDataPath ?? appUserDataPath()
  const environments = environmentsReachedThrough(userDataPath, targetId).filter(
    (environment) => !isRuntimeEnvironmentManuallyDisconnected(environment.id)
  )
  environments.forEach((environment) => markRuntimeEnvironmentManuallyDisconnected(environment.id))
  const teardown = disconnectRegisteredSshTarget(targetId)
  if (environments.length > 0) {
    // Import lazily because runtime-environments wires handlers and imports this SSH layer.
    const invalidateTransport =
      runtimeLayer?.invalidateTransport ??
      (await import('../runtime-environments/runtime-environments'))
        .invalidateRuntimeEnvironmentTransport
    for (const environment of environments) {
      // A Connect during the import already lifted this server; tearing it down would undo that.
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        disconnectRuntimeEnvironmentForUser(environment.id, { userDataPath, invalidateTransport })
      }
    }
  }
  await teardown
}

/** The status bar's Disconnect of a managed server is a Disconnect of the machine it runs on. */
export async function disconnectManagedHostOfEnvironmentForUser(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment'>,
  runtimeLayer: RuntimeLayer
): Promise<void> {
  const targetId = getOrcadSshDeployment(environment)?.sshTargetId
  if (targetId) {
    await disconnectSshHostForUser(targetId, runtimeLayer)
  }
}

/** The status bar's Connect of a server lifts the Disconnect of the SSH host it is reached through. */
export async function liftSshUserDisconnectForEnvironment(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'sshAccess'>
): Promise<void> {
  const managedHostId = getOrcadSshDeployment(environment)?.sshTargetId
  if (managedHostId && isSshUserDisconnected(managedHostId)) {
    // Host Connect republishes managed status and restores forwards removed by Disconnect.
    await connectRegisteredSshTarget(managedHostId)
    return
  }
  clearSshUserDisconnectedForEnvironment(environment)
}

let launchReconnectOptOutsHeld = false

/** Opted-out hosts start each launch as if the user had disconnected them: nothing dials them, servers included, until Connect. Once per process, before server status probes start. */
export function holdLaunchReconnectOptOuts(
  targets: readonly Pick<SshTarget, 'id' | 'reconnectOnLaunch'>[],
  userDataPath: string = appUserDataPath()
): void {
  if (launchReconnectOptOutsHeld) {
    return
  }
  launchReconnectOptOutsHeld = true
  for (const target of targets) {
    if (target.reconnectOnLaunch !== false) {
      continue
    }
    recordSshUserDisconnected(target.id)
    for (const environment of environmentsReachedThrough(userDataPath, target.id)) {
      markRuntimeEnvironmentManuallyDisconnected(environment.id)
    }
  }
}

export function resetLaunchReconnectOptOutsForTests(): void {
  launchReconnectOptOutsHeld = false
}

/** Stop and remove persists across reloads and restarts: automatic dials must not deploy a new server. */
export function isManagedServerRemovalHeld(
  target: Pick<SshTarget, 'managedServerRemoved' | 'orcadFence'> | undefined
): boolean {
  if (!target?.managedServerRemoved) {
    return false
  }
  // An older desktop ignores the hold and may redeploy; its registered server stays reachable.
  const environmentId = getManagedOrcadFenceEnvironmentId(target)
  return (
    !environmentId ||
    !listEnvironments(appUserDataPath()).some((environment) => environment.id === environmentId)
  )
}

/** Explicit host Connect lifts its servers; resume their status checks only after connection settles. */
export function liftSshHostUserDisconnect(targetId: string): string[] {
  clearSshUserDisconnected(targetId)
  const registry = getSshTargetRegistryStore()
  if (registry?.getTarget(targetId)?.managedServerRemoved) {
    registry.updateTarget(targetId, { managedServerRemoved: undefined })
  }
  const lifted: string[] = []
  for (const environment of environmentsReachedThrough(appUserDataPath(), targetId)) {
    if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      lifted.push(environment.id)
    }
  }
  return lifted
}

/** Resume after connect to avoid status probes racing it for the same SSH host. */
export function resumeRuntimeEnvironmentStatus(environmentIds: readonly string[]): void {
  for (const environmentId of environmentIds) {
    if (!isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      getRuntimeEnvironmentStatusOwner(appUserDataPath(), environmentId).activate()
    }
  }
}
