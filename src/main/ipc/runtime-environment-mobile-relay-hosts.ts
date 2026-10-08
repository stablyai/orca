import { app } from 'electron'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeEnvironmentStatus
} from '../../shared/runtime-host-status'
import type { MobileDesktopRelayHosts } from '../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import type { SshConnectionState } from '../../shared/ssh-types'
import { getRegisteredSshState, listRegisteredSshTargets } from '../ssh/ssh-target-registry'
import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const retirementListeners = new Set<(environmentId: string) => void>()

/** Called wherever the desktop's own transport to a server is invalidated. */
export function retireMobileDesktopRelayEnvironment(environmentId: string): void {
  for (const listener of retirementListeners) {
    listener(environmentId)
  }
}

/** The desktop's configured servers, addressed only by exact environment id. */
export function createRuntimeEnvironmentMobileRelayHosts(): MobileDesktopRelayHosts {
  // Why userData: configured servers live where the runtime-environment handlers keep them.
  const userDataPath = app.getPath('userData')
  return {
    list: () => {
      const environments = listEnvironments(userDataPath)
      const statusByEnvironmentId = new Map<string, RuntimeEnvironmentStatus>()
      for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
        const environment = environments.find((entry) => entry.id === snapshot.environmentId)
        // Why: as in the renderer, a snapshot from an earlier pairing says nothing about this one.
        if (environment && pairingRevision(environment) === snapshot.pairingRevision) {
          statusByEnvironmentId.set(environment.id, runtimeEnvironmentStatusFromSnapshot(snapshot))
        }
      }
      const sshTargets = listRegisteredSshTargets()
      const sshConnectionStates = new Map<string, SshConnectionState>()
      for (const target of sshTargets) {
        const state = getRegisteredSshState(target.id)
        if (state) {
          sshConnectionStates.set(target.id, state)
        }
      }
      return {
        sshTargetLabels: new Map(sshTargets.map((target) => [target.id, target.label])),
        sshConnectionStates,
        environments: environments.map((environment) => ({
          id: environment.id,
          name: environment.name,
          source: environment.source,
          orcadDeployment: environment.orcadDeployment,
          pairingRevision: pairingRevision(environment),
          runtimeId: environment.runtimeId
        })),
        statusByEnvironmentId
      }
    },
    resolve: async (environmentId) => {
      if (!listEnvironments(userDataPath).some((entry) => entry.id === environmentId)) {
        return null
      }
      const environment = await resolveManagedRuntimeEnvironment(userDataPath, environmentId)
      return {
        environmentId,
        fence: relayHostFence(environment),
        pairing: getPreferredPairingOffer(environment)
      }
    },
    call: (host, method, params, options) =>
      callRuntimeEnvironment(
        userDataPath,
        host.environmentId,
        method,
        params,
        options?.timeoutMs,
        options?.expected?.pairingRevision,
        undefined,
        options?.expected?.runtimeId
          ? { expectedEnvironmentRuntimeId: options.expected.runtimeId }
          : undefined
      ),
    onEnvironmentRetired: (listener) => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    }
  }
}

function pairingRevision(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

function relayHostFence(environment: KnownRuntimeEnvironment): string {
  return `${pairingRevision(environment)}\0${environment.runtimeId}`
}
