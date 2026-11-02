import { getAppEnvironment } from '../../../shared/app-environment'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  clearSshUserDisconnected,
  clearSshUserDisconnectedForEnvironment,
  isSshUserDisconnected,
  recordSshUserDisconnected
} from '../../ssh/ssh-user-disconnect'
import { connectRegisteredSshTarget } from '../../ssh/ssh-target-registry'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected,
  markRuntimeEnvironmentManuallyDisconnected
} from '../runtime-environments/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from '../runtime-environments/runtime-environment-request-connections'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'

/**
 * A server reached through an SSH host cannot work without it, and its status checks redial it.
 * So a user's Disconnect of either one (Settings or the status bar) takes down both, and only an
 * explicit Connect of either one brings both back; every surface then reads the same verdict.
 */

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
  // Why synchronously, before any await: a status check already in flight must not redial, and the
  // teardown must reserve the target's lifecycle so a later Connect queues behind it.
  recordSshUserDisconnected(targetId)
  const userDataPath = runtimeLayer?.userDataPath ?? appUserDataPath()
  const environments = environmentsReachedThrough(userDataPath, targetId).filter(
    (environment) => !isRuntimeEnvironmentManuallyDisconnected(environment.id)
  )
  environments.forEach((environment) => markRuntimeEnvironmentManuallyDisconnected(environment.id))
  const teardown = disconnectRegisteredSshTarget(targetId)
  if (environments.length > 0) {
    // Why lazy: runtime-environments wires every runtime handler and imports the SSH layer.
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
    // Why: the host's own Connect republishes its managed verdict and restores its port forwards,
    // which the status bar's Disconnect tore down with the host.
    await connectRegisteredSshTarget(managedHostId)
    return
  }
  clearSshUserDisconnectedForEnvironment(environment)
}

/**
 * An explicit Connect of an SSH host lifts its Disconnect and that of the servers reached through it.
 * Returns the servers lifted, whose status checks resume once the connect settles.
 */
export function liftSshHostUserDisconnect(targetId: string): string[] {
  clearSshUserDisconnected(targetId)
  const lifted: string[] = []
  for (const environment of environmentsReachedThrough(appUserDataPath(), targetId)) {
    if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      lifted.push(environment.id)
    }
  }
  return lifted
}

/** Why after the connect: an earlier status check would race the connect for the same host. */
export function resumeRuntimeEnvironmentStatus(environmentIds: readonly string[]): void {
  for (const environmentId of environmentIds) {
    if (!isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      getRuntimeEnvironmentStatusOwner(appUserDataPath(), environmentId).activate()
    }
  }
}
