import { app } from 'electron'
import { pairedRuntimeBrowserClientHostsPage } from '../../browser/paired-runtime-browser-client-host-runtime'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeEnvironmentStatus
} from '../../../shared/runtime-host-status'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from '../../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { getRegisteredSshState, listRegisteredSshTargets } from '../../ssh/ssh-target-registry'
import { getRuntimeEnvironmentStatusSnapshots } from './runtime-environment-request-connections'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime-client'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { onRuntimeEnvironmentStatusPublished } from './runtime-environment-status-owner'
import { getRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'

const retirementListeners = new Set<(environmentId: string) => void>()

/** Called wherever the desktop's own transport to a server is invalidated. */
export function retireMobileDesktopRelayEnvironment(environmentId: string): void {
  for (const listener of retirementListeners) {
    listener(environmentId)
  }
}

/**
 * Servers a phone may reach through this desktop. Not WSL hosts: they are this desktop's own
 * distros, connected only for work open here, so a phone must not wake or route to them.
 */
function listRelayableEnvironments(userDataPath: string) {
  return listEnvironments(userDataPath).filter(isRelayableToPhones)
}

function isRelayableToPhones(environment: KnownRuntimeEnvironment): boolean {
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'network':
      return true
    case 'wsl':
      return false
  }
}

/** The desktop's configured servers, addressed only by exact environment id. */
export function createRuntimeEnvironmentMobileRelayHosts(): MobileDesktopRelayHosts {
  // Why userData: configured servers live where the runtime-environment handlers keep them.
  const userDataPath = app.getPath('userData')
  return {
    list: () => {
      const environments = listRelayableEnvironments(userDataPath)
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
          runtimeId: environment.runtimeId,
          ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
        })),
        statusByEnvironmentId
      }
    },
    resolve: async (environmentId) => {
      if (!listRelayableEnvironments(userDataPath).some((entry) => entry.id === environmentId)) {
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
    hostsBrowserPage: pairedRuntimeBrowserClientHostsPage,
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
  callbacks: { onChange: () => void; onClose: () => void }
): MobileDesktopRelayHostWatch {
  const controller = new AbortController()
  let subscription: RemoteRuntimeSubscription | null = null
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
    (entry) => entry.id === environmentId
  )
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
          if (isRuntimeSubscriptionReplayResponse(response) || isWorkspaceChange(response.result)) {
            callbacks.onChange()
          }
        }
      },
      onClose: end
    },
    current,
    controller.signal
  ).then((opened) => {
    subscription = opened
    if (controller.signal.aborted) {
      opened.close()
    }
  }, end)
  return { close, current }
}

function isWorkspaceChange(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false
  }
  return (
    message.type === 'ready' ||
    message.type === 'worktreesChanged' ||
    message.type === 'reposChanged'
  )
}

function pairingRevision(environment: KnownRuntimeEnvironment): number {
  return environment.pairingRevision ?? environment.createdAt
}

function relayHostFence(environment: KnownRuntimeEnvironment): string {
  return `${pairingRevision(environment)}\0${environment.runtimeId}`
}
