/**
 * How the move driver reaches its WSL host. A move the user started (the dialog's preview or
 * start) may boot the distro and lifts a park; an automatic one (the orchestrator, including its
 * startup recovery) never boots it (A1, E9). Neither reconnects a host that is already serving,
 * and a host with a Remove still pending is never touched.
 */
import { findWslHostDeployment } from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import { ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import type { WslHostService } from '../../wsl/host-lifecycle/wsl-host-service'
import type { WslMoveHostServerState } from '../../persistence/moving-wsl-projects/execution/wsl-move-driver-ports'
import { defaultWslOrcadEnvironmentId } from '../../wsl/orcad/wsl-orcad-deploy'

export type WslMoveHostConnectMode = 'user' | 'automatic'

/** E11 (#33843): a Remove that could not prove the server stopped leaves `pendingStop` set. */
export async function wslHostRemovalPending(
  userDataPath: string,
  distro: string
): Promise<boolean> {
  const record: object | null = await findWslHostDeployment(
    userDataPath,
    defaultWslOrcadEnvironmentId(distro)
  )
  // Optional until #33843 lands: older records have no such field.
  return !!record && 'pendingStop' in record && !!record.pendingStop
}

/** False when there is no host to use; throws when it would not connect. */
export async function connectWslMoveHostService(
  service: Pick<
    WslHostService,
    'recordForEnvironment' | 'getStatuses' | 'connect' | 'ensureForRuntimeCall'
  >,
  userDataPath: string,
  distro: string,
  mode: WslMoveHostConnectMode
): Promise<boolean> {
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  if (
    !(await service.recordForEnvironment(environmentId)) ||
    (await wslHostRemovalPending(userDataPath, distro))
  ) {
    return false
  }
  if (mode === 'automatic') {
    await service.ensureForRuntimeCall(environmentId)
  } else if (
    // connect() would bump the liveness generation and re-ensure a server that already serves.
    !service
      .getStatuses()
      .some((status) => status.environmentId === environmentId && status.state === 'ready')
  ) {
    await service.connect(environmentId)
  }
  return true
}

/**
 * What the connected server's deferral says a missing WSL capability means. A ready server with
 * no update waiting runs this build (or a newer one), so the cause is how it was started.
 */
export function wslMoveHostServerState(
  service: Pick<WslHostService, 'getStatuses'>,
  environmentId: string
): { serverState?: WslMoveHostServerState } {
  const status = service.getStatuses().find((entry) => entry.environmentId === environmentId)
  if (status?.state !== 'ready') {
    return {}
  }
  const code = status.deferredUpdate?.code
  return {
    serverState:
      code === ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE
        ? 'restart-offered'
        : code
          ? 'update-pending'
          : 'current'
  }
}
