import { getAppEnvironment } from '../../../shared/app-environment'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  getOrcadSshDeployment,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  clearSshUserDisconnected,
  clearSshUserDisconnectedForEnvironment,
  isSshUserDisconnected,
  recordSshUserDisconnected
} from '../../ssh/connection/ssh-user-disconnect'
import {
  connectRegisteredSshTarget,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'
import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected,
  markRuntimeEnvironmentManuallyDisconnected
} from '../runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentStatusOwner } from '../runtime-environments/connections/runtime-environment-request-connections'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'
import { noteRuntimeEnvironmentConnectRequested } from '../runtime-environments/pairing/runtime-environment-pairing-refusal-registry'
import { clearSshCredentialDeclinedForEnvironment } from '../../ssh/authentication/ssh-credential-decline'

/** Managed server and SSH host share user disconnect intent; only explicit Connect may restore either. */

type InvalidateTransport = (environmentId: string) => Promise<void> | void
type RuntimeLayer = { userDataPath: string; invalidateTransport: InvalidateTransport }

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

async function environmentsReachedThrough(
  userDataPath: string,
  targetId: string
): Promise<KnownRuntimeEnvironment[]> {
  return (await listEnvironments(userDataPath)).filter(
    (environment) => getRuntimeSshAccess(environment)?.sshTargetId === targetId
  )
}

export async function disconnectRuntimeEnvironmentForUser(
  environmentId: string,
  { userDataPath, invalidateTransport }: RuntimeLayer
): Promise<void> {
  markRuntimeEnvironmentManuallyDisconnected(environmentId)
  void invalidateTransport(environmentId)
  // Retain disconnected evidence for renderers that missed the teardown event.
  await getRuntimeEnvironmentStatusOwner(userDataPath, environmentId)
}

export async function disconnectSshHostForUser(
  targetId: string,
  runtimeLayer?: RuntimeLayer
): Promise<void> {
  // Fence status probes and reserve teardown synchronously so later Connect queues behind it.
  recordSshUserDisconnected(targetId)
  const userDataPath = runtimeLayer?.userDataPath ?? appUserDataPath()
  const environments = (await environmentsReachedThrough(userDataPath, targetId)).filter(
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
        await disconnectRuntimeEnvironmentForUser(environment.id, {
          userDataPath,
          invalidateTransport
        })
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

/** Update, Recover and like actions lift what Connect lifts but dial the host themselves, skipping Connect's server-update check. Returns the servers to resume afterwards. */
export async function liftUserHoldsForServerAction(
  environment: KnownRuntimeEnvironment
): Promise<string[]> {
  const lifted = isRuntimeEnvironmentManuallyDisconnected(environment.id) ? [environment.id] : []
  clearRuntimeEnvironmentManualDisconnect(environment.id)
  noteRuntimeEnvironmentConnectRequested(environment.id)
  clearSshCredentialDeclinedForEnvironment(environment)
  const targetId = getRuntimeSshAccess(environment)?.sshTargetId
  return targetId
    ? [...new Set([...lifted, ...(await liftSshHostUserDisconnect(targetId))])]
    : lifted
}

let launchReconnectOptOutsHeld: Promise<void> | undefined

/** Opted-out hosts start each launch as if the user had disconnected them: nothing dials them, servers included, until Connect. Once per process, before server status probes start. */
export async function holdLaunchReconnectOptOuts(
  targets: readonly Pick<SshTarget, 'id' | 'label' | 'reconnectOnLaunch'>[],
  userDataPath: string = appUserDataPath()
): Promise<void> {
  return (launchReconnectOptOutsHeld ??= (async () => {
    const held = targets.filter((target) => target.reconnectOnLaunch === false)
    held.forEach((target) => recordSshUserDisconnected(target.id))
    if (held.length === 0) {
      return
    }
    const environments = await listEnvironments(userDataPath)
    const byTarget = new Map(held.map((target) => [target.id, target]))
    for (const environment of environments) {
      const targetId = getRuntimeSshAccess(environment)?.sshTargetId
      const target = targetId ? byTarget.get(targetId) : undefined
      if (target && isSshUserDisconnected(target.id)) {
        markRuntimeEnvironmentManuallyDisconnected(
          environment.id,
          `Reconnect on launch is off for ${target.label}. Connect to resume.`
        )
      }
    }
  })())
}

export function resetLaunchReconnectOptOutsForTests(): void {
  launchReconnectOptOutsHeld = undefined
}

/** Stop and remove persists across reloads and restarts: automatic dials must not deploy a new server. */
export async function isManagedServerRemovalHeld(
  target: Pick<SshTarget, 'managedServerRemoved' | 'orcadFence'> | undefined
): Promise<boolean> {
  if (!target?.managedServerRemoved) {
    return false
  }
  // An older desktop ignores the hold and may redeploy; its registered server stays reachable.
  const environmentId = getManagedOrcadFenceEnvironmentId(target)
  return (
    !environmentId ||
    !(await listEnvironments(appUserDataPath())).some(
      (environment) => environment.id === environmentId
    )
  )
}

/** Explicit host Connect lifts its servers; resume their status checks only after connection settles. */
export async function liftSshHostUserDisconnect(targetId: string): Promise<string[]> {
  clearSshUserDisconnected(targetId)
  const registry = getSshTargetRegistryStore()
  if (registry?.getTarget(targetId)?.managedServerRemoved) {
    registry.updateTarget(targetId, { managedServerRemoved: undefined })
  }
  const lifted: string[] = []
  for (const environment of await environmentsReachedThrough(appUserDataPath(), targetId)) {
    if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
      clearRuntimeEnvironmentManualDisconnect(environment.id)
      lifted.push(environment.id)
    }
  }
  return lifted
}

/** Resume after connect to avoid status probes racing it for the same SSH host. */
export async function resumeRuntimeEnvironmentStatus(
  environmentIds: readonly string[]
): Promise<void> {
  for (const environmentId of environmentIds) {
    if (!isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
      ;(await getRuntimeEnvironmentStatusOwner(appUserDataPath(), environmentId)).activate()
    }
  }
}
