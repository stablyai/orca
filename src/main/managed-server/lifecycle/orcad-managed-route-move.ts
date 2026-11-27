import type { KnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/remote-runtime/ssh/managed-orcad-ssh-owner'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import { releaseUnlinkedHostTransport } from '../../ipc/ssh/ssh-session-teardown'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import { ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'

/** Makes `target` the only SSH route of a saved server that just moved to it and returns the server once its tunnel is rebuilt. Routes it left are released, held from automatic redeploys and hung up. */
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
  try {
    await claims.flush(args.signal)
    return await ensureOrcadManagedTunnel(userDataPath, environmentId)
  } finally {
    for (const route of leftRoutes) {
      await runTargetLifecycle(route.id, () => releaseUnlinkedHostTransport(route.id))
    }
  }
}
