import { describePairedServerHosts } from '../../../../shared/remote-runtime/host-catalog/paired-server-hosts'
import {
  pairedRuntimeBrowserClientHostId,
  pairedRuntimeBrowserClientHostsPage
} from '../../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { prepareRuntimeEnvironmentBrowserPlacement } from '../browser-hosting/runtime-environment-browser-placement'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { classifyRuntimeEnvironmentHost } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeEnvironmentStatus
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { MobileDesktopRelayHosts } from '../../../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  prepareManagedRuntimeRequest,
  type ManagedRuntimeCallPreparation
} from '../managed-orcad/runtime-environment-managed-tunnel'
import { wslHostsGateOpen } from '../../../wsl/host-lifecycle/wsl-host-gate'
import type { WslHostPhoneReach } from '../../../wsl/host-lifecycle/wsl-host-phone-reach'
import {
  getWslHostPhoneGate,
  getWslHostService,
  onWslHostStatusesChanged
} from '../../../wsl/host-lifecycle/wsl-host-service-instance'
import type { SshConnectionState } from '../../../../shared/remote-runtime/ssh/ssh-types'
import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../../ssh/targets/ssh-target-registry'
import { getRuntimeEnvironmentStatusSnapshots } from '../connections/runtime-environment-request-connections'
import { callRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'
import { runtimeEnvironmentManualDisconnectCount } from '../connectivity/runtime-environment-manual-disconnect'
import { onRuntimeEnvironmentStatusPublished } from '../status/runtime-environment-status-owner'
import { watchRuntimeEnvironmentRegistry } from '../catalog/runtime-environment-preference'
import { watchRuntimeEnvironmentChanges } from './watch-runtime-environment-changes'
import { getRuntimeEnvironmentRegistryRoot } from '../catalog/runtime-environment-registry-root'
import { recipeVmServerState } from '../managed-orcad/runtime-environment-recipe-vm-wake'
import { RECIPE_VM_PHONE_OPEN_HOLD_MS } from '../../../../shared/remote-runtime/recipe-vm-wake'

const retirementListeners = new Set<(environmentId: string) => void>()

export function retireMobileDesktopRelayEnvironment(environmentId: string): void {
  for (const listener of retirementListeners) {
    listener(environmentId)
  }
}

// Why: a WSL host is this desktop's own distro; a phone reaches it only while it already runs.
// A phone's open of a sleeping recipe VM is answered before the phone itself gives up.
const PHONE_CALL_PREPARATION: ManagedRuntimeCallPreparation = {
  wslStart: 'never',
  recipeVmHoldMs: RECIPE_VM_PHONE_OPEN_HOLD_MS
}

/** Servers a phone may reach, each with its WSL host reach (null for any other server). */
async function listRelayableEnvironments(
  userDataPath: string
): Promise<{ environment: KnownRuntimeEnvironment; reach: WslHostPhoneReach | null }[]> {
  // One records read per list: the phone polls it every few seconds.
  const wslReaches = wslHostsGateOpen() ? await getWslHostPhoneGate()?.reachAll() : undefined
  const relayable: { environment: KnownRuntimeEnvironment; reach: WslHostPhoneReach | null }[] = []
  for (const environment of await listEnvironments(userDataPath)) {
    const reach =
      classifyRuntimeEnvironmentHost(environment).kind === 'wsl'
        ? (wslReaches?.get(environment.id) ?? 'hidden')
        : null
    if (reach !== 'hidden') {
      relayable.push({ environment, reach })
    }
  }
  return relayable
}

// Why: a phone never starts a WSL host, so a host not ready here says where it can be started.
function desktopWslHostFlags(reach: WslHostPhoneReach | null): {
  stoppedOnDesktop?: true
  unavailableOnDesktop?: true
} {
  if (reach === 'stopped') {
    return { stoppedOnDesktop: true }
  }
  return reach === 'unavailable' ? { unavailableOnDesktop: true } : {}
}

/** Relay requests use exact saved environment IDs. */
export function createRuntimeEnvironmentMobileRelayHosts(): MobileDesktopRelayHosts {
  const userDataPath = getRuntimeEnvironmentRegistryRoot()
  return {
    list: async () => {
      const relayable = await listRelayableEnvironments(userDataPath)
      const environments = relayable.map(({ environment }) => environment)
      const environmentById = new Map(
        environments.map((environment) => [environment.id, environment])
      )
      const reachById = new Map(relayable.map(({ environment, reach }) => [environment.id, reach]))
      const statusByEnvironmentId = new Map<string, RuntimeEnvironmentStatus>()
      for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
        const environment = environmentById.get(snapshot.environmentId)
        // Earlier pairings cannot establish the current server status.
        if (
          environment &&
          pairingRevision(environment) === snapshot.pairingRevision &&
          // A WSL host's last status counts only while the desktop holds it connected.
          (reachById.get(environment.id) ?? 'ready') === 'ready'
        ) {
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
          runtimeId: environment.runtimeId,
          ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {}),
          ...desktopWslHostFlags(reachById.get(environment.id) ?? null)
        })),
        statusByEnvironmentId
      }
    },
    resolve: async (environmentId, openingMethod, signal) => {
      if (
        !(await listRelayableEnvironments(userDataPath)).some(
          ({ environment }) => environment.id === environmentId
        )
      ) {
        return null
      }
      const prepared = await prepareManagedRuntimeRequest(
        userDataPath,
        environmentId,
        PHONE_CALL_PREPARATION,
        openingMethod,
        signal
      )
      const { environment } = prepared
      return {
        environmentId,
        fence: relayHostFence(environment),
        pairingRevision: pairingRevision(environment),
        ...(prepared.wokenPairingRevision === pairingRevision(environment)
          ? { wokenByOpening: true as const }
          : {}),
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
        {
          preparation: PHONE_CALL_PREPARATION,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.expected?.runtimeId
            ? { expectedEnvironmentRuntimeId: options.expected.runtimeId }
            : {})
        }
      ),
    serverStateForOpening: async (environmentId) =>
      await recipeVmServerState(userDataPath, environmentId),
    userDisconnects: runtimeEnvironmentManualDisconnectCount,
    hostsBrowserPage: pairedRuntimeBrowserClientHostsPage,
    browserHostClientId: pairedRuntimeBrowserClientHostId,
    prepareBrowserHost: (host, enabled) =>
      prepareRuntimeEnvironmentBrowserPlacement(userDataPath, {
        selector: host.environmentId,
        expectedPairingRevision: host.pairingRevision,
        preference: 'auto',
        requireStatus: true,
        enabled
      }),
    onEnvironmentRetired: (listener) => {
      retirementListeners.add(listener)
      return () => retirementListeners.delete(listener)
    },
    // A WSL host's reach (hidden, stopped, ready) is part of its listing too.
    onStatusChanged: (listener) => {
      const stopStatus = onRuntimeEnvironmentStatusPublished((snapshot) => {
        const health = describePairedServerHosts({
          environments: [{ id: snapshot.environmentId }],
          statusByEnvironmentId: new Map([
            [snapshot.environmentId, runtimeEnvironmentStatusFromSnapshot(snapshot)]
          ]),
          sshTargetLabels: new Map(),
          sshConnectionStates: new Map(),
          hostLabelOverrides: new Map()
        })[0]?.health
        listener({ environmentId: snapshot.environmentId, inContact: health === 'available' })
      })
      const stopWsl = onWslHostStatusesChanged(() => {
        for (const status of getWslHostService()?.getStatuses() ?? []) {
          if (status.state !== 'ready') {
            listener({ environmentId: status.environmentId, inContact: false })
          }
        }
        listener()
      })
      return () => {
        stopStatus()
        stopWsl()
      }
    },
    // Its own watch: serve has no window, so the renderer catalog broadcast never runs there.
    onCatalogChanged: (listener) =>
      watchRuntimeEnvironmentRegistry(userDataPath, listener, 'Phone server list'),
    watchChanges: async (host, expected, callbacks) =>
      await watchRuntimeEnvironmentChanges({
        userDataPath,
        environmentId: host.environmentId,
        expected,
        preparation: PHONE_CALL_PREPARATION,
        findEnvironment: async () => {
          const environment = (await listRelayableEnvironments(userDataPath)).find(
            (entry) => entry.environment.id === host.environmentId
          )?.environment
          return environment
            ? { pairingRevision: pairingRevision(environment), runtimeId: environment.runtimeId }
            : undefined
        },
        callbacks
      })
  }
}

function pairingRevision(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

function relayHostFence(environment: KnownRuntimeEnvironment): string {
  return `${pairingRevision(environment)}\0${environment.runtimeId}`
}
