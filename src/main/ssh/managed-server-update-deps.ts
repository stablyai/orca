/** The live update-check collaborators, shared by the connect decision and the tunnel restore. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { ManagedServerUpdateDeps } from './managed-server-update-check'
import { autoUpdateManagedOrcadEnvironment } from '../managed-server/lifecycle/orcad-managed-auto-update'
import { requireManagedOrcadTargetStore } from '../managed-server/lifecycle/orcad-managed-runtime-context'

// Hosts whose update failed this launch. Session-only: SshTarget is published to peers.
const failedThisLaunch = new Set<string>()

export function managedServerUpdateDeps(userDataPath: string): ManagedServerUpdateDeps {
  const registry = requireManagedOrcadTargetStore()
  const appVersion = getAppEnvironment().getVersion()
  return {
    autoUpdate: (environmentId, options) =>
      autoUpdateManagedOrcadEnvironment(userDataPath, { environmentId, appVersion, ...options }),
    // Why the stored row: the caller's target is a copy taken before an overlapping check recorded.
    recordedUpdateFailure: (target) => {
      const failure = (registry.getTarget(target.id) ?? target).managedServerUpdateFailure
      return failure?.appVersion === appVersion ? failure.reason : null
    },
    // Why only a failure counts: a deferral or skip never tried the update.
    failedThisLaunch: (target) => failedThisLaunch.has(target.id),
    recordUpdateFailure: (target, reason) => {
      failedThisLaunch.add(target.id)
      registry.updateTarget(target.id, { managedServerUpdateFailure: { reason, appVersion } })
    },
    clearUpdateFailure: (target) => {
      registry.updateTarget(target.id, { managedServerUpdateFailure: undefined })
    }
  }
}
