import {
  pairedRuntimeBrowserClientHostId,
  pairedRuntimeBrowserClientHostsPage
} from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { prepareRuntimeEnvironmentBrowserPlacement } from './runtime-environment-browser-placement'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { classifyRuntimeEnvironmentHost } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeEnvironmentStatus
} from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from '../../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  prepareManagedRuntimeRequest,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'
import { wslHostsGateOpen } from '../../wsl/host-lifecycle/wsl-host-gate'
import type { WslHostPhoneReach } from '../../wsl/host-lifecycle/wsl-host-phone-reach'
import { getWslHostPhoneGate } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import type { SshConnectionState } from '../../../shared/ssh-types'
import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../ssh/targets/ssh-target-registry'
import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'
import type { RemoteRuntimeTransportSubscription } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  runtimeEnvironmentManualDisconnectCount
} from './runtime-environment-manual-disconnect'
import { onRuntimeEnvironmentStatusPublished } from './runtime-environment-status-owner'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'
import { getRuntimeEnvironmentRegistryRoot } from './runtime-environment-registry-root'
import { recipeVmServerState } from './runtime-environment-recipe-vm-wake'
import { RECIPE_VM_PHONE_OPEN_HOLD_MS } from '../../../shared/remote-runtime/recipe-vm-wake'

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
function listRelayableEnvironments(
  userDataPath: string
): { environment: KnownRuntimeEnvironment; reach: WslHostPhoneReach | null }[] {
  // One records read per list: the phone polls it every few seconds.
  const wslReaches = wslHostsGateOpen() ? getWslHostPhoneGate()?.reachAll() : undefined
  const relayable: { environment: KnownRuntimeEnvironment; reach: WslHostPhoneReach | null }[] = []
  for (const environment of listEnvironments(userDataPath)) {
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
    list: () => {
      const relayable = listRelayableEnvironments(userDataPath)
      const environments = relayable.map(({ environment }) => environment)
      const reachById = new Map(relayable.map(({ environment, reach }) => [environment.id, reach]))
      const statusByEnvironmentId = new Map<string, RuntimeEnvironmentStatus>()
      for (const snapshot of getRuntimeEnvironmentStatusSnapshots()) {
        const environment = environments.find((entry) => entry.id === snapshot.environmentId)
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
        !listRelayableEnvironments(userDataPath).some(
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
    serverStateForOpening: (environmentId) => recipeVmServerState(userDataPath, environmentId),
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
    onStatusChanged: onRuntimeEnvironmentStatusPublished,
    watchChanges: (host, expected, callbacks) =>
      watchRuntimeEnvironmentChanges(userDataPath, host.environmentId, expected, callbacks)
  }
}

/** Main's own client-event stream to one server, bound to the transport and pairing it opened on. */
function watchRuntimeEnvironmentChanges(
  userDataPath: string,
  environmentId: string,
  expected: { pairingRevision: number; runtimeId: string | null },
  callbacks: Parameters<MobileDesktopRelayHosts['watchChanges']>[2]
): MobileDesktopRelayHostWatch {
  const controller = new AbortController()
  let subscription: RemoteRuntimeTransportSubscription | null = null
  const generation = getRuntimeEnvironmentTransportGeneration(environmentId)
  const current = (): boolean =>
    !controller.signal.aborted &&
    getRuntimeEnvironmentTransportGeneration(environmentId) === generation
  const close = (): void => {
    controller.abort()
    subscription?.close()
  }
  const end = (): void => {
    if (!controller.signal.aborted) {
      close()
      callbacks.onClose()
    }
  }
  const environment = listRelayableEnvironments(userDataPath).find(
    (entry) => entry.environment.id === environmentId
  )?.environment
  if (
    !environment ||
    isRuntimeEnvironmentManuallyDisconnected(environmentId) ||
    pairingRevision(environment) !== expected.pairingRevision ||
    environment.runtimeId !== expected.runtimeId
  ) {
    queueMicrotask(end)
    return { close, current }
  }
  subscribeRuntimeEnvironment(
    userDataPath,
    environmentId,
    'runtime.clientEvents.subscribe',
    undefined,
    15_000,
    {
      onEvent: (payload) => {
        if (payload.type === 'response' && payload.response.ok && current()) {
          const { response } = payload
          // A replay may stand for missed events of any kind.
          const change = isRuntimeSubscriptionReplayResponse(response)
            ? 'reposChanged'
            : workspaceChangeOf(response.result)
          if (change) {
            callbacks.onChange({ catalog: change !== 'worktreesChanged' })
          }
        }
      },
      onClose: end
    },
    current,
    controller.signal,
    PHONE_CALL_PREPARATION
  ).then((opened) => {
    subscription = opened
    if (controller.signal.aborted) {
      opened.close()
    }
  }, end)
  return { close, current }
}

function workspaceChangeOf(message: unknown): 'ready' | 'worktreesChanged' | 'reposChanged' | null {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return null
  }
  const { type } = message
  return type === 'ready' || type === 'worktreesChanged' || type === 'reposChanged' ? type : null
}

function pairingRevision(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

function relayHostFence(environment: KnownRuntimeEnvironment): string {
  return `${pairingRevision(environment)}\0${environment.runtimeId}`
}
