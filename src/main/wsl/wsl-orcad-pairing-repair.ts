/**
 * Pairing again with a WSL host whose orcad refused this desktop's enrolled token (a lost device
 * registry, a revoked device), through the managed SSH repair gate: one repair at a time, a capped
 * number per window, and only an offer under the pinned host key. The distro runs on this machine,
 * so its published offer is read from the distro itself, as SSH reads it over SSH.
 */
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import {
  findWslHostDeployment,
  refreshWslHostPairing
} from '../../shared/runtime-environment-wsl-host-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { readActiveManagedOrcadReadiness } from '../managed-server/lifecycle/orcad-managed-bound-port'
import {
  ManagedOrcadPairingRepairs,
  type ManagedOrcadPairingRepairDeps
} from '../managed-server/lifecycle/orcad-managed-pairing-repair'
import type { WslOrcadHostTransport } from './wsl-orcad-host-transport'
import { OrcadManagedPairingRepairFailedError } from '../managed-server/lifecycle/orcad-managed-pairing-repair-failure'
import { notifyManagedOrcadPairingRepaired } from '../managed-server/lifecycle/orcad-managed-pairing-repaired-listener'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import type { WslOrcadPairingRecovery } from './wsl-orcad-pairing-identity'

type WslOrcadHostAccess = { target: WslOrcadHostTarget; connection: WslOrcadHostTransport }

export function liveWslOrcadPairingRepairDeps(
  userDataPath: string
): ManagedOrcadPairingRepairDeps<WslOrcadHostAccess> {
  const record = (environmentId: string) => {
    const found = findWslHostDeployment(userDataPath, environmentId)
    if (!found) {
      throw new OrcadManagedPairingRepairFailedError('this server is not a WSL host')
    }
    return found
  }
  return {
    resolve: (environmentId) => resolveEnvironment(userDataPath, environmentId),
    connect: async (environment: KnownRuntimeEnvironment) => {
      const target: WslOrcadHostTarget = {
        kind: 'wsl',
        id: environment.id,
        distro: record(environment.id).distro,
        label: environment.name
      }
      return { target, connection: createWslOrcadHostTransport({ target }) }
    },
    readReadiness: async (access) => {
      try {
        return await readActiveManagedOrcadReadiness(access)
      } finally {
        access.connection.dispose()
      }
    },
    ports: (environment) => {
      const found = findWslHostDeployment(userDataPath, environment.id)
      return found ? { localPort: found.localPort, remotePort: found.remotePort } : null
    },
    refresh: (environmentId, pairingCode) => {
      const { localPort, remotePort } = record(environmentId)
      return refreshWslHostPairing(userDataPath, environmentId, {
        pairingCode,
        localPort,
        remotePort
      }).environment
    },
    repaired: notifyManagedOrcadPairingRepaired,
    now: Date.now
  }
}

/** One gate per desktop, so the cap and a standing failure hold across every WSL connect. */
export function createWslOrcadPairingRecovery(
  userDataPath: string,
  deps: ManagedOrcadPairingRepairDeps<WslOrcadHostAccess> = liveWslOrcadPairingRepairDeps(
    userDataPath
  )
): Omit<WslOrcadPairingRecovery, 'environmentId'> {
  return { repairs: new ManagedOrcadPairingRepairs(deps), resolve: deps.resolve }
}
