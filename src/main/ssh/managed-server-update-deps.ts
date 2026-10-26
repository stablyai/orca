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
    // Re-read the store: caller snapshots may predate an overlapping check's failure.
    recordedUpdateFailure: (target) => {
      const failure = (registry.getTarget(target.id) ?? target).managedServerUpdateFailure
      return failure?.appVersion === appVersion ? failure.reason : null
    },
    // Only attempted failures suppress retry; keep launch-only state out of peer-published SshTarget.
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
