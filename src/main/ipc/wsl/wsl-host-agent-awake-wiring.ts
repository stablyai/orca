/** Production wiring for keep-awake's WSL-host agents: each ready host's own session-tabs stream. */
import type { AgentAwakeService } from '../../power/agent-awake-service'
import { WslHostAgentAwake, type WslHostAgentAwakeDeps } from '../../power/wsl-host-agent-awake'
import { runWslHostAgentAwakeWhileAuto } from '../../power/wsl-host-agent-awake-mode-gate'
import {
  getWslHostService,
  onWslHostStatusesChanged
} from '../../wsl/host-lifecycle/wsl-host-service-instance'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/catalog/runtime-environment-registry-root'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from '../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { classifyRuntimeEnvironmentHost } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { decodeRuntimeEnvironmentSubscriptionEvents } from '../runtime-environments/subscriptions/runtime-environment-subscription-events'
import { isRuntimeEnvironmentManuallyDisconnected } from '../runtime-environments/connectivity/runtime-environment-manual-disconnect'

const STREAM_METHOD = 'session.tabs.subscribeAll'
const REQUEST_TIMEOUT_MS = 15_000
/** The socket tells the host it only watches, so a host that understands it can still idle out.
 *  Older hosts ignore an unknown client capability; they are held busy by the desktop's shared
 *  control socket anyway, so watching them costs nothing extra. */
export const WSL_HOST_AGENT_AWAKE_CLIENT_CAPABILITIES = [
  ...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  IDLE_PASSIVE_CLIENT_CAPABILITY
]

type QuietTransport = {
  /** The host's paired connection, or null when it is not a WSL host. */
  resolve: (environmentId: string) => Promise<PairedRuntimeConnection | null>
  subscribe: typeof subscribeRemoteRuntimeTransport
  isManuallyDisconnected: (environmentId: string) => boolean
}

const defaultTransport: QuietTransport = {
  resolve: async (environmentId) => {
    const environment = await resolveEnvironment(getRuntimeEnvironmentRegistryRoot(), environmentId)
    return classifyRuntimeEnvironmentHost(environment).kind === 'wsl'
      ? getPreferredPairedRuntimeConnection(environment)
      : null
  },
  subscribe: subscribeRemoteRuntimeTransport,
  isManuallyDisconnected: isRuntimeEnvironmentManuallyDisconnected
}

/**
 * Opens a ready WSL host's stream on its own passive socket. Why not the shared runtime call path:
 * that path may start the distro, tells paired phones a host stopped, and stamps Settings' "last used".
 */
export function createQuietWslHostStreamOpener(
  transport: QuietTransport = defaultTransport
): WslHostAgentAwakeDeps['openStream'] {
  return async (environmentId, handlers) => {
    const connection = await transport.resolve(environmentId)
    if (handlers.signal.aborted || !connection || transport.isManuallyDisconnected(environmentId)) {
      return 'unsupported'
    }
    let ended = false
    const end = (): void => {
      if (!ended) {
        ended = true
        handlers.onEnd()
      }
    }
    const onEvent = decodeRuntimeEnvironmentSubscriptionEvents(
      STREAM_METHOD,
      (payload) => {
        if (payload.type === 'response' && payload.response.ok) {
          handlers.onFrame(payload.response.result)
        } else if (payload.type !== 'binary') {
          // An error response, transport error or close leaves the stream unable to report.
          end()
        }
      },
      () => !ended
    )
    const subscription = await transport.subscribe(
      connection,
      STREAM_METHOD,
      {},
      REQUEST_TIMEOUT_MS,
      {
        onResponse: (response) => onEvent({ type: 'response', response }),
        onError: (error) => onEvent({ type: 'error', code: error.code, message: error.message }),
        onClose: end
      },
      { clientCapabilities: WSL_HOST_AGENT_AWAKE_CLIENT_CAPABILITIES, signal: handlers.signal }
    )
    return {
      close: () => {
        ended = true
        subscription.close()
      }
    }
  }
}

/** Watches ready WSL hosts only while keep-awake is Auto; mode changes start or tear it down. */
export function startWslHostAgentAwake(service: AgentAwakeService): () => void {
  const openStream = createQuietWslHostStreamOpener()
  return runWslHostAgentAwakeWhileAuto(
    service,
    () =>
      new WslHostAgentAwake({
        listHosts: () => getWslHostService()?.getStatuses() ?? [],
        onHostsChanged: onWslHostStatusesChanged,
        openStream,
        report: (environmentId, statuses) => service.setWslHostStatuses(environmentId, statuses),
        now: Date.now
      })
  )
}
