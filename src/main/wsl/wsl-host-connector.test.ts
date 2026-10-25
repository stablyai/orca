import { expect, it, vi } from 'vitest'
import { createWslHostConnector } from './wsl-host-connector'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type * as TunnelIdentity from '../managed-server/lifecycle/orcad-managed-tunnel-identity'

const mocks = vi.hoisted(() => ({
  readRunning: vi.fn<() => Promise<WslRunningDistrosRead>>(),
  connect: vi.fn(),
  stopServer: vi.fn(async () => ({ stopped: true })),
  verify: vi.fn(),
  ready: vi.fn(() => false)
}))
vi.mock('../wsl-background-distro-gate', () => ({
  readConfirmedRunningWslDistros: mocks.readRunning,
  listConfirmedRunningWslDistros: vi.fn(async () => [])
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof TunnelIdentity>()),
  verifyOrcadPairingIdentity: mocks.verify
}))
vi.mock('./wsl-orcad-liveness-wiring', () => ({
  createWslOrcadLivenessSupervisor: () => ({ connect: mocks.connect })
}))
vi.mock('./wsl-host-server-stop', () => ({
  stopWslHostServer: mocks.stopServer,
  wslHostRuntimeStopSteps: vi.fn(() => ({})),
  decommissionWslHostOrcad: vi.fn()
}))

it('uses owned readiness without discovery and coalesces cold cleanup without waking stopped or unknown guests', async () => {
  const connector = createWslHostConnector({
    userDataPath: '/unused',
    onChange: vi.fn(),
    hasUserVisibleWork: () => false,
    isKnownDistro: () => true,
    runtime: { isReady: mocks.ready, call: vi.fn(), census: vi.fn() }
  })
  mocks.ready.mockReturnValue(true)
  await expect(connector.isReachable('Ubuntu', 'wsl:ubuntu')).resolves.toBe(true)
  expect(mocks.readRunning).not.toHaveBeenCalled()
  expect(mocks.verify).not.toHaveBeenCalled()
  mocks.ready.mockReturnValue(false)
  mocks.readRunning.mockResolvedValueOnce({ status: 'confirmed', distros: [] })
  const passive = connector.isReachable('Ubuntu', 'wsl:ubuntu')
  const removal = connector.stopServer('Ubuntu', 'wsl:ubuntu')
  await expect(passive).resolves.toBe(false)
  await expect(removal).resolves.toEqual({ stopped: true })
  expect(mocks.readRunning).toHaveBeenCalledTimes(1)
  mocks.readRunning.mockResolvedValueOnce({ status: 'unavailable' })
  await expect(connector.stopServer('Ubuntu', 'wsl:ubuntu')).resolves.toMatchObject({
    stopped: false
  })
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.verify).not.toHaveBeenCalled()
  expect(mocks.stopServer).not.toHaveBeenCalled()
  mocks.readRunning.mockResolvedValueOnce({ status: 'confirmed', distros: ['Ubuntu'] })
  await expect(connector.stopServer('Ubuntu', 'wsl:ubuntu')).resolves.toEqual({ stopped: true })
  expect(mocks.connect).toHaveBeenCalledOnce()
  expect(mocks.stopServer).toHaveBeenCalledOnce()
})
