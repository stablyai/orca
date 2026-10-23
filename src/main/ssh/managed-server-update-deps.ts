/** The live update-check collaborators, shared by the connect decision and the tunnel restore. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { ManagedServerUpdateDeps } from './managed-server-update-check'
import { autoUpdateManagedOrcadEnvironment } from '../managed-server/lifecycle/orcad-managed-auto-update'
import { requireManagedOrcadTargetStore } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import {
  orcadUpdateFailedThisLaunch,
  recordOrcadUpdateFailedThisLaunch
} from '../managed-server/lifecycle/orcad-managed-update-failure-memory'

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
    // Why only a failure counts: a deferral or skip never tried the update. Why session-only:
    // SshTarget is published to peers.
    failedThisLaunch: (target) => orcadUpdateFailedThisLaunch({ kind: 'ssh', id: target.id }),
    recordUpdateFailure: (target, reason) => {
      recordOrcadUpdateFailedThisLaunch(
        { kind: 'ssh', id: target.id },
        { code: 'orcad_update_failed', reason }
      )
      registry.updateTarget(target.id, { managedServerUpdateFailure: { reason, appVersion } })
    },
    clearUpdateFailure: (target) => {
      registry.updateTarget(target.id, { managedServerUpdateFailure: undefined })
    }
  }
}
