import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayHostWatch
} from '../../../runtime/mobile-desktop-relay/mobile-desktop-relay-hosts'
import type { ManagedRuntimeCallPreparation } from '../managed-orcad/runtime-environment-managed-tunnel'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { getRuntimeEnvironmentTransportGeneration } from '../connections/runtime-environment-transport-generation'
import { subscribeRuntimeEnvironment } from '../requests/runtime-environment-transport-routing'
import { subscribeSharedRuntimeClientEvents } from '../subscriptions/shared-runtime-client-events'
import { isRuntimeSubscriptionReplayResponse } from '../../../../shared/remote-runtime/rpc/runtime-subscription-replay'
import { serverClientEventChange } from './runtime-environment-change-events'

/** Main's own client-event stream to one server, sharing any active desktop or relay stream on that transport. */
export async function watchRuntimeEnvironmentChanges(args: {
  userDataPath: string
  environmentId: string
  expected: { pairingRevision: number; runtimeId: string | null }
  preparation: ManagedRuntimeCallPreparation
  findEnvironment: () => Promise<{ pairingRevision: number; runtimeId: string | null } | undefined>
  callbacks: Parameters<MobileDesktopRelayHosts['watchChanges']>[2]
}): Promise<MobileDesktopRelayHostWatch> {
  const { userDataPath, environmentId, expected, preparation, findEnvironment, callbacks } = args
  const controller = new AbortController()
  let subscription: { close: () => void } | null = null
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
  const environment = await findEnvironment()
  if (
    !environment ||
    // The transport moved on while we looked the pairing up; don't join or open the old channel.
    !current() ||
    isRuntimeEnvironmentManuallyDisconnected(environmentId) ||
    environment.pairingRevision !== expected.pairingRevision ||
    environment.runtimeId !== expected.runtimeId
  ) {
    queueMicrotask(end)
    return { close, current }
  }
  const shared = subscribeSharedRuntimeClientEvents({
    environmentId,
    transportGeneration: generation,
    openUpstream: (upstreamCallbacks, signal) =>
      subscribeRuntimeEnvironment(
        userDataPath,
        environmentId,
        'runtime.clientEvents.subscribe',
        undefined,
        15_000,
        {
          onEvent: (payload) => {
            if (payload.type === 'response') {
              upstreamCallbacks.onResponse(payload.response)
            }
          },
          onClose: upstreamCallbacks.onClose
        },
        () =>
          !signal.aborted && getRuntimeEnvironmentTransportGeneration(environmentId) === generation,
        signal,
        preparation
      ),
    onResponse: (response) => {
      if (response.ok && current()) {
        // A replay may stand for missed events of any kind.
        const change = isRuntimeSubscriptionReplayResponse(response)
          ? 'reposChanged'
          : serverClientEventChange(response.result)
        if (change === 'agentRows') {
          callbacks.onRowsChanged?.()
        } else if (change) {
          callbacks.onChange({ catalog: change !== 'worktreesChanged' })
        }
      }
    },
    onClose: end
  })
  subscription = shared
  if (controller.signal.aborted) {
    shared.close()
  }
  return { close, current }
}
