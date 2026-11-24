import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeHostStatusOwner } from '../../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runtimeEnvironmentConnectionPairingKey as getPairingKey } from '../connections/runtime-environment-capability-evidence'
import { createRuntimeEnvironmentStatusOwner } from './runtime-environment-status-owner'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import type * as Transports from '../connections/runtime-environment-request-connections'

type RegistryTransports = Pick<
  typeof Transports,
  | 'closeRemoteRuntimeRequestConnection'
  | 'getRemoteRuntimeSharedControlDiagnostics'
  | 'sendRemoteRuntimeSharedControlRequest'
  | 'ensureRemoteRuntimeSharedControlConnection'
  | 'reconnectRemoteRuntimeSharedControlConnection'
  | 'pauseRemoteRuntimeSharedControlRetry'
>

export function createRuntimeEnvironmentStatusOwnerRegistry({
  closeRemoteRuntimeRequestConnection,
  getRemoteRuntimeSharedControlDiagnostics,
  sendRemoteRuntimeSharedControlRequest,
  ensureRemoteRuntimeSharedControlConnection,
  reconnectRemoteRuntimeSharedControlConnection,
  pauseRemoteRuntimeSharedControlRetry
}: RegistryTransports) {
  const statusOwners = new Map<string, { key: string; owner: RuntimeHostStatusOwner }>()
  async function getRuntimeEnvironmentStatusOwner(
    userDataPath: string,
    selector: string
  ): Promise<RuntimeHostStatusOwner> {
    return withRuntimeEnvironmentStatusOwner(userDataPath, selector, (_environment, owner) => owner)
  }

  /** Owns fresh pairing selection through synchronous status publication. */
  async function withRuntimeEnvironmentStatusOwner<T>(
    userDataPath: string,
    selector: string,
    consume: (environment: KnownRuntimeEnvironment, owner: RuntimeHostStatusOwner) => T
  ): Promise<T> {
    const environment = await resolveEnvironment(userDataPath, selector)
    const pairedConnection = getPreferredPairedRuntimeConnection(environment)
    const key = `${userDataPath}\0${environment.pairingRevision ?? environment.createdAt}\0${getPairingKey(pairedConnection)}`
    let cached = statusOwners.get(environment.id)
    if (!cached || cached.key !== key || cached.owner.read().retired) {
      if (cached) {
        closeRemoteRuntimeRequestConnection(environment.id)
      }
      const owner = createRuntimeEnvironmentStatusOwner(userDataPath, environment, {
        isReady: () => getRemoteRuntimeSharedControlDiagnostics(environment.id)?.state === 'ready',
        request: (signal) =>
          sendRemoteRuntimeSharedControlRequest<RuntimeStatus>(
            environment.id,
            pairedConnection,
            'status.get',
            undefined,
            15_000,
            undefined,
            signal
          ),
        establish: () => {
          ensureRemoteRuntimeSharedControlConnection(environment.id, pairedConnection)
          reconnectRemoteRuntimeSharedControlConnection(environment.id)
        },
        pause: () => pauseRemoteRuntimeSharedControlRetry(environment.id)
      })
      cached = { key, owner }
      statusOwners.set(environment.id, cached)
      if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
        owner.dispose()
      }
    }
    return consume(environment, cached.owner)
  }

  function resetRuntimeEnvironmentStatusOwners(): void {
    for (const id of statusOwners.keys()) {
      closeRemoteRuntimeRequestConnection(id)
    }
  }

  function getRuntimeEnvironmentStatusSnapshot(environmentId: string) {
    return statusOwners.get(environmentId)?.owner.read() ?? null
  }

  function getRuntimeEnvironmentStatusSnapshots() {
    return [...statusOwners.values()].map(({ owner }) => owner.read())
  }

  function getOwnedRuntimeEnvironmentStatusOwner(
    environmentId: string
  ): RuntimeHostStatusOwner | undefined {
    return statusOwners.get(environmentId)?.owner
  }
  function retireRuntimeEnvironmentStatusOwner(environmentId: string): void {
    const status = statusOwners.get(environmentId)
    statusOwners.delete(environmentId)
    status?.owner.dispose()
  }

  return {
    getRuntimeEnvironmentStatusOwner,
    withRuntimeEnvironmentStatusOwner,
    resetRuntimeEnvironmentStatusOwners,
    getRuntimeEnvironmentStatusSnapshot,
    getRuntimeEnvironmentStatusSnapshots,
    getOwnedRuntimeEnvironmentStatusOwner,
    retireRuntimeEnvironmentStatusOwner
  }
}
