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
import { classifyRuntimeEnvironmentHost } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import { subscribeRemoteRuntimeTransport } from '../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { isRuntimeEnvironmentManuallyDisconnected } from '../runtime-environments/connectivity/runtime-environment-manual-disconnect'

export { PASSIVE_SESSION_CLIENT_CAPABILITIES as WSL_HOST_AGENT_AWAKE_CLIENT_CAPABILITIES } from '../runtime-environments/subscriptions/runtime-environment-passive-session-stream'
import {
  createPassiveSessionStreamOpener,
  type PassiveSessionTransport
} from '../runtime-environments/subscriptions/runtime-environment-passive-session-stream'

type QuietTransport = PassiveSessionTransport

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
  return createPassiveSessionStreamOpener(transport)
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
