import { describe, expect, it } from 'vitest'
import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import { withOwnBuildLaunchEnv } from './wsl-orcad-own-build-launch-env'

function transport(): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper reads only orcadLaunchEnv.
  return {
    orcadLaunchEnv: async () => [['ORCA_WSL_DISTRO_GUID', 'g']]
  } as unknown as OrcadHostTransport
}

describe('withOwnBuildLaunchEnv', () => {
  it('adds the malloc tunables when the launched slot is this build', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => '0.1.0+own')
    await expect(conn.orcadLaunchEnv?.({ fullVersion: '0.1.0+own' })).resolves.toEqual([
      ['ORCA_WSL_DISTRO_GUID', 'g'],
      ...hostMallocTunablesLaunchEnv()
    ])
  })

  it('withholds them from an older slot, which would leak them to user shells', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => '0.1.0+own')
    await expect(conn.orcadLaunchEnv?.({ fullVersion: '0.1.0+older' })).resolves.toEqual([
      ['ORCA_WSL_DISTRO_GUID', 'g']
    ])
  })

  it('withholds them before this build’s version is known', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => null)
    await expect(conn.orcadLaunchEnv?.({ fullVersion: '0.1.0+own' })).resolves.toEqual([
      ['ORCA_WSL_DISTRO_GUID', 'g']
    ])
  })
})
