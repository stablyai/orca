import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'

/** An older slot would leak GLIBC_TUNABLES to user shells, so only this build's own slot gets it. */
export function withOwnBuildLaunchEnv<T extends OrcadHostTransport>(
  conn: T,
  ownBuildVersion: () => string | null
): T {
  const orcadLaunchEnv: OrcadHostTransport['orcadLaunchEnv'] = async (launch) => [
    ...((await conn.orcadLaunchEnv?.(launch)) ?? []),
    ...(launch.fullVersion === ownBuildVersion() ? hostMallocTunablesLaunchEnv() : [])
  ]
  // Delegate rather than spread so prototype methods survive; #private fields would still need explicit forwarding.
  return Object.create(conn, { orcadLaunchEnv: { value: orcadLaunchEnv } })
}
