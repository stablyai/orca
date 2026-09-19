import type { OrcadManagedCancelStopResult } from '../../shared/orcad-managed-runtime'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { requestRemoteOrcadManagedStopCancellation } from './orcad-decommission-client'
import { cancelInterruptedOrcadManagedStop } from './orcad-managed-stop-cancellation'
import {
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'

export async function cancelManagedOrcadStop(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal }
): Promise<OrcadManagedCancelStopResult> {
  const environment = requireManagedOrcadEnvironment(userDataPath, args.selector)
  return runTargetLifecycle(environment.orcadDeployment!.sshTargetId, async () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    const context = await resolveLinkedOrcadContext(environment, args.signal)
    return cancelInterruptedOrcadManagedStop({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      runtimeId: environment.runtimeId ?? '',
      signal: args.signal,
      requestCancellation: async (request) => {
        await ensureOrcadManagedTunnel(userDataPath, environment.id)
        return requestRemoteOrcadManagedStopCancellation(environment, request)
      }
    })
  })
}
