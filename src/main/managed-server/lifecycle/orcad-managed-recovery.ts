import { redactRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { OrcadManagedRecoveryResult } from '../../../shared/orcad-managed-runtime'
import { recoverInterruptedOrcadActivation } from '../activation/orcad-activation-recovery'
import { managedOrcadSlot, resolveLinkedOrcadContext } from './orcad-managed-runtime-context'

import { refreshMaintainedOrcadPairing } from './orcad-maintenance-pairing-refresh'
import type { LifecycleArgs } from './orcad-managed-lifecycle'
import { withManagedOrcadLifecycle, followLaunchedServerPort } from './orcad-managed-lifecycle'

export async function recoverManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs & { acceptChangedState?: boolean }
): Promise<OrcadManagedRecoveryResult> {
  return await withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const result = await recoverInterruptedOrcadActivation({
        ...managedOrcadSlot(context, deployment.remotePort, args.signal),
        acceptChangedState: args.acceptChangedState === true
      })
      if (result.outcome !== 'recovered') {
        return result
      }
      const updated = result.readiness
        ? await refreshMaintainedOrcadPairing(userDataPath, environment.id, result.readiness)
        : environment
      if (result.activeVersion) {
        await followLaunchedServerPort(userDataPath, environment.id)
      }
      return {
        outcome: 'recovered',
        resolution: result.resolution,
        activeVersion: result.activeVersion,
        environment: redactRuntimeEnvironment(updated)
      }
    }
  )
}
