import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'

/** An older slot would leak GLIBC_TUNABLES to user shells, so only this build's own slot gets it. */
export function withOwnBuildLaunchEnv(
  conn: OrcadHostTransport,
  ownBuildVersion: () => string | null
): OrcadHostTransport {
  const launchEnv = conn.orcadLaunchEnv
  return {
    ...conn,
    orcadLaunchEnv: async (launch) => [
      ...((await launchEnv?.(launch)) ?? []),
      ...(launch.fullVersion === ownBuildVersion() ? hostMallocTunablesLaunchEnv() : [])
    ]
  }
}
