import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/remote-runtime/ssh/managed-orcad-ssh-owner'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import { releaseUnlinkedHostTransport } from '../../ipc/ssh/ssh-session-teardown'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'

export async function finishManagedOrcadRouteMove(
  userDataPath: string,
  args: {
    environmentId: string
    target: SshTarget
    provisionalEnvironmentId: string
    signal?: AbortSignal
  }
): Promise<KnownRuntimeEnvironment> {
  const { environmentId, target } = args
  const { claims } = requireManagedOrcadInfrastructure()
  claims.release(target.id, args.provisionalEnvironmentId)
  claims.claim(target.id, environmentId, { ownerRecorded: true })
  const leftRoutes = claims
    .listTargets()
    .filter(
      (route) =>
        route.id !== target.id && getManagedOrcadFenceEnvironmentId(route) === environmentId
    )
  for (const route of leftRoutes) {
    claims.releaseForUserRemoval(route.id, environmentId)
  }
  await claims.flush(args.signal)
  const environment = await ensureOrcadManagedTunnel(userDataPath, environmentId)
  for (const route of leftRoutes) {
    await runTargetLifecycle(route.id, () => releaseUnlinkedHostTransport(route.id))
  }
  return environment
}
