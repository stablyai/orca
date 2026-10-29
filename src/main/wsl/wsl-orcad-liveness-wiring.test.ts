import { beforeEach, expect, it, vi } from 'vitest'
import type { WslOrcadLivenessDependencies } from './wsl-orcad-liveness-state'

const mocks = vi.hoisted(() => {
  const captured: { deps: WslOrcadLivenessDependencies | null } = { deps: null }
  return { readSettled: vi.fn(), captured }
})
vi.mock('../wsl-background-distro-gate', () => ({
  deferUntilWslDistroRunning: vi.fn(),
  readSettledConfirmedRunningWslDistros: mocks.readSettled
}))
vi.mock('./wsl-orcad-liveness-supervisor', () => ({
  WslOrcadLivenessSupervisor: class {
    constructor(deps: WslOrcadLivenessDependencies) {
      mocks.captured.deps = deps
    }
  }
}))

import { createWslOrcadLivenessSupervisor } from './wsl-orcad-liveness-wiring'
import { EXIT_SETTLE_MS } from './wsl-orcad-liveness-evidence'

beforeEach(() => {
  mocks.readSettled.mockReset().mockResolvedValue({ status: 'confirmed', distros: ['Ubuntu'] })
  createWslOrcadLivenessSupervisor({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the captured deps under test never touch these.
    manager: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the captured deps under test never touch these.
    bridgeActivity: {} as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the captured deps under test never touch these.
    holder: {} as never,
    hasUserVisibleWork: () => false
  })
})

it('reads a settled running list for heartbeats and recovery, not one probed mid-stop (E9)', async () => {
  await mocks.captured.deps?.readRunning({ distro: 'Ubuntu' })
  expect(mocks.readSettled).toHaveBeenLastCalledWith('Ubuntu', undefined)

  await mocks.captured.deps?.readRunning({ distro: 'Ubuntu', exitedAt: 1_000 })
  expect(mocks.readSettled).toHaveBeenLastCalledWith('Ubuntu', 1_000 + EXIT_SETTLE_MS)
})

it('checks a no-boot reconnect against a settled read of its own distro (E9)', async () => {
  await expect(mocks.captured.deps?.requireRunning?.('Ubuntu')).resolves.toBe(true)
  expect(mocks.readSettled).toHaveBeenLastCalledWith('Ubuntu')

  mocks.readSettled.mockResolvedValue({ status: 'confirmed', distros: [] })
  await expect(mocks.captured.deps?.requireRunning?.('Ubuntu')).resolves.toBe(false)
})
