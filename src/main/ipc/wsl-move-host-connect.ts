/**
 * How the move driver reaches its WSL host. A move the user started (the dialog's preview or
 * start) may boot the distro and lifts a park; an automatic one (the orchestrator, including its
 * startup recovery) never boots it (A1, E9). Neither reconnects a host that is already serving,
 * and a host with a Remove still pending is never touched.
 */
import { findWslHostDeployment } from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostService } from '../wsl/wsl-host-service'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'

export type WslMoveHostConnectMode = 'user' | 'automatic'

/** E11 (#33843): a Remove that could not prove the server stopped leaves `pendingStop` set. */
export function wslHostRemovalPending(userDataPath: string, distro: string): boolean {
  const record: object | null = findWslHostDeployment(
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
  if (!service.recordForEnvironment(environmentId) || wslHostRemovalPending(userDataPath, distro)) {
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
