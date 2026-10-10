import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { resolveOrcadDeploymentTargetFacts } from './orcad-deployment-target'
import { OrcadHostUnsupportedError } from './orcad-host-unavailable'
import type { SshConnection } from './ssh-connection'
import { pinnedRuntimeTargetForHost } from './ssh-relay-runtime-ladder'
import type { RemoteHostPlatform } from './ssh-remote-platform'

/**
 * The runtime target managed orcad deploys on a host, picked by glibc exactly as the relay ladder
 * picks rung A or B: the host's own target, or its compat runtime below the default's glibc floor.
 */
export async function resolveOrcadRuntimeTarget(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<NodeRuntimeTarget> {
  const facts = await resolveOrcadDeploymentTargetFacts(options)
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new OrcadHostUnsupportedError(
      `No Orca runtime supports ${facts.target} with glibc ${glibc}.`
    )
  }
  return target
}
