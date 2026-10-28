import { describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { WslOrcadLivenessDependencies } from './wsl-orcad-liveness-state'

const mocks = vi.hoisted(() => ({
  deps: new Array<WslOrcadLivenessDependencies>(),
  readSettled: vi.fn<(distro: string, startedAfter?: number) => Promise<WslRunningDistrosRead>>(
    async () => ({ status: 'confirmed', distros: ['Ubuntu'] })
  )
}))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readSettledConfirmedRunningWslDistros: mocks.readSettled
}))
vi.mock('./wsl-orcad-liveness-supervisor', () => ({
  WslOrcadLivenessSupervisor: class {
    constructor(deps: WslOrcadLivenessDependencies) {
      mocks.deps.push(deps)
    }
  }
}))

import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import type { WslOrcadConnectionManager } from './wsl-orcad-connection'
import type { WslOrcadBridgeActivity } from './wsl-orcad-bridge-activity'
import type { WslDistroHolder } from './wsl-distro-holder'

// E9 L1: a no-boot reconnect's last check must not trust a list probed while the distro still stops.
describe('liveness wiring running checks', () => {
  it('asks for a settled running read for the distro before a no-boot reconnect', async () => {
    createWslOrcadLivenessSupervisor({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the supervisor is mocked; these are only passed through.
      manager: {} as WslOrcadConnectionManager,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked supervisor.
      bridgeActivity: {} as WslOrcadBridgeActivity,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked supervisor.
      holder: {} as WslDistroHolder,
      hasUserVisibleWork: () => false
    })
    const deps = mocks.deps[0]

    await expect(deps.requireRunning?.('Ubuntu')).resolves.toBe(true)
    expect(mocks.readSettled).toHaveBeenCalledWith('Ubuntu')
  })
})
