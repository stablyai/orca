// Reread readiness after unanswered tunnels: another desktop may have restarted orcad on a new port.
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { OrcadManagedServing } from './orcad-managed-serving'
import type { OrcadManagedServingCheck } from './orcad-managed-tunnel-resume'
import type { ActiveOrcadTunnel } from './orcad-managed-tunnel-active'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type { SshTarget } from '../../../shared/ssh-types'
import type { OrcadManagedTunnelTargeting } from './orcad-managed-tunnel-target'

export type OrcadTunnelServing = OrcadManagedServing & { rebind?: true }

export async function checkManagedTunnelServing(input: {
  environment: KnownRuntimeEnvironment
  active: Map<string, ActiveOrcadTunnel>
  getTarget: (targetId: string) => SshTarget | null | undefined
  forwards: Pick<SshPortForwardManager, 'removeForwardAndWait'>
  ensureServing: OrcadManagedServingCheck | undefined
  readPublishedPort?: OrcadManagedTunnelTargeting['readPublishedPort']
}): Promise<OrcadTunnelServing> {
  const { environment, active: tunnels } = input
  const active = tunnels.get(environment.id)
  const target = active && input.getTarget(active.targetId)
  if (!active || !target || !input.ensureServing) {
    return { state: 'unverifiable', detail: 'The tunnel to this host’s Orca server is not up.' }
  }
  const serving = await input.ensureServing({
    environment,
    target,
    connection: active.connection,
    remotePort: active.remotePort
  })
  const boundPort =
    serving.state === 'started'
      ? serving.boundPort
      : serving.state === 'unverifiable'
        ? ((await input.readPublishedPort?.({
            environment,
            target,
            connection: active.connection
          })) ?? null)
        : null
  if (boundPort === null || boundPort === active.remotePort) {
    return serving
  }
  if (tunnels.get(environment.id) === active) {
    tunnels.delete(environment.id)
  }
  await input.forwards.removeForwardAndWait(active.forwardId)
  return { ...serving, rebind: true }
}
