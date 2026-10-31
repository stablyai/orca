import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { resolveOrcadDeploymentTargetFacts } from '../../ssh/orcad-deployment-target'
import { OrcadHostUnsupportedError } from '../../orcad/orcad-host-unavailable'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { pinnedRuntimeTargetForHost } from '../../ssh/pinned-runtime-host-target'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Lets a caller that knows the host kind add its own fix; the message is the one SSH shows. */
export class OrcadHostGlibcUnsupportedError extends OrcadHostUnsupportedError {
  constructor(target: string, glibc: string) {
    super(`No Orca runtime supports ${target} with glibc ${glibc}.`)
  }
}

export async function resolveOrcadRuntimeTarget(options: {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<NodeRuntimeTarget> {
  const facts = await resolveOrcadDeploymentTargetFacts(options)
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new OrcadHostGlibcUnsupportedError(facts.target, glibc)
  }
  return target
}
