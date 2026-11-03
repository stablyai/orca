import { expect, it, vi } from 'vitest'
import { createWslHostConnector } from './wsl-host-connector'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type * as TunnelIdentity from '../managed-server/lifecycle/orcad-managed-tunnel-identity'

const mocks = vi.hoisted(() => ({
  readRunning: vi.fn<(distro: string) => Promise<WslRunningDistrosRead>>(),
  connect: vi.fn(),
  stopServer: vi.fn(async () => ({ stopped: true })),
  verify: vi.fn(),
  ready: vi.fn(() => false),
  lastSeenRunning: vi.fn((_distro: string) => true),
  managerGet: vi.fn((): unknown => null),
  managerEnsure: vi.fn(),
  managerIsConnecting: vi.fn(() => false)
}))
vi.mock('./wsl-orcad-connection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WslOrcadConnectionManager: class {
    get = mocks.managerGet
    ensure = mocks.managerEnsure
    isConnecting = mocks.managerIsConnecting
  }
}))
vi.mock('../wsl-background-distro-gate', () => ({
  // Settled per distro: a list taken while it stops still names it (E9).
  readSettledConfirmedRunningWslDistros: mocks.readRunning,
  wasWslDistroLastSeenRunningSettled: mocks.lastSeenRunning,
  noteWslDistroMayHaveStopped: vi.fn(),
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
  expect(mocks.readRunning).toHaveBeenCalledWith('Ubuntu')
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

it('a ready client never stands in for a running read once the distro may have stopped (E9)', async () => {
  const connector = createWslHostConnector({
    userDataPath: '/unused',
    onChange: vi.fn(),
    hasUserVisibleWork: () => false,
    isKnownDistro: () => true,
    runtime: { isReady: mocks.ready, call: vi.fn(), census: vi.fn() }
  })
  mocks.ready.mockReturnValue(true)
  // Its control socket has not closed yet, but the last settled list no longer names it.
  mocks.lastSeenRunning.mockReturnValueOnce(false).mockReturnValueOnce(false)
  mocks.readRunning.mockReset().mockResolvedValue({ status: 'confirmed', distros: [] })
  await expect(connector.reachability('Ubuntu', 'wsl:ubuntu')).resolves.toBe('stopped')
  await expect(connector.isReachable('Ubuntu', 'wsl:ubuntu')).resolves.toBe(false)
  expect(mocks.readRunning).toHaveBeenCalledWith('Ubuntu')
  mocks.ready.mockReturnValue(false)
})

function joinFixture() {
  mocks.connect.mockReset()
  mocks.managerGet.mockReset().mockReturnValue(null)
  mocks.managerEnsure.mockReset()
  mocks.managerIsConnecting.mockReset().mockReturnValue(false)
  const bridge = { distro: 'Ubuntu', localPort: 41000 }
  mocks.managerEnsure.mockResolvedValue(bridge)
  let finish: (connection: unknown) => void = () => {}
  mocks.connect.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const connector = createWslHostConnector({
    userDataPath: '/unused',
    onChange: vi.fn(),
    hasUserVisibleWork: () => true,
    isKnownDistro: () => true,
    runtime: { isReady: () => false, call: vi.fn(), census: vi.fn() }
  })
  return { connector, bridge, finish: () => finish(bridge) }
}

it('joins a plain connect already in flight instead of re-arming liveness for it', async () => {
  const { connector, bridge, finish } = joinFixture()
  const first = connector.connect('Ubuntu')
  await expect(connector.connect('Ubuntu')).resolves.toBe(bridge)
  expect(mocks.connect).toHaveBeenCalledOnce()
  // Once the bridge is up, a call needs no wait at all, even while liveness still arms.
  mocks.managerGet.mockReturnValue(bridge)
  await expect(connector.connect('ubuntu')).resolves.toBe(bridge)
  expect(mocks.managerEnsure).toHaveBeenCalledOnce()

  finish()
  await first
  mocks.connect.mockResolvedValueOnce(bridge)
  await connector.connect('Ubuntu')
  expect(mocks.connect).toHaveBeenCalledTimes(2)
})

it('a no-boot call joins a booting connect but stays no-boot itself (E9)', async () => {
  const { connector, finish } = joinFixture()
  const first = connector.connect('Ubuntu')
  await connector.connect('Ubuntu', { noBoot: true })
  expect(mocks.connect).toHaveBeenCalledOnce()
  // It reaches the manager with its running check, so it can only ride the boot already happening.
  expect(mocks.managerEnsure).toHaveBeenCalledWith(
    'Ubuntu',
    expect.objectContaining({ requireRunning: expect.any(Function) })
  )
  // That check is a settled read, so a distro still stopping counts as stopped.
  const [, ensureOptions] = mocks.managerEnsure.mock.lastCall ?? []
  mocks.readRunning.mockClear().mockResolvedValueOnce({ status: 'confirmed', distros: ['Ubuntu'] })
  await expect(ensureOptions?.requireRunning('Ubuntu')).resolves.toBe(true)
  expect(mocks.readRunning).toHaveBeenCalledWith('Ubuntu')
  finish()
  await first
})

it('a connect that may boot never rides a no-boot one, and intents never join (E9)', async () => {
  const { connector, bridge, finish } = joinFixture()
  const first = connector.connect('Ubuntu', { noBoot: true })
  mocks.connect.mockResolvedValue(bridge)
  await connector.connect('Ubuntu')
  expect(mocks.connect).toHaveBeenCalledTimes(2)
  expect(mocks.connect).toHaveBeenLastCalledWith('Ubuntu', {})
  await connector.connect('Ubuntu', { intent: 'update' })
  expect(mocks.connect).toHaveBeenCalledTimes(3)
  expect(mocks.managerEnsure).not.toHaveBeenCalled()
  finish()
  await first
})

it('never hands a joined call the server an in-flight connect is replacing', async () => {
  const { connector, bridge, finish } = joinFixture()
  const incumbent = { distro: 'Ubuntu', localPort: 40000 }
  mocks.managerGet.mockReturnValue(incumbent)
  mocks.managerIsConnecting.mockReturnValue(true)

  // A plain connect redeploying: a call waits for the new bridge, not the outgoing one.
  const first = connector.connect('Ubuntu')
  await expect(connector.connect('Ubuntu')).resolves.toBe(bridge)
  expect(mocks.managerEnsure).toHaveBeenCalledOnce()
  finish()
  await first

  // An Update in flight is never joined: the call goes through liveness, as before.
  const replacement = { distro: 'Ubuntu', localPort: 42000 }
  let finishUpdate: (connection: unknown) => void = () => {}
  mocks.connect.mockReturnValueOnce(
    new Promise((resolve) => {
      finishUpdate = resolve
    })
  )
  const update = connector.connect('Ubuntu', { intent: 'update' })
  mocks.connect.mockResolvedValueOnce(replacement)
  const call = connector.connect('Ubuntu')
  await expect(call).resolves.toBe(replacement)
  expect(mocks.connect).toHaveBeenCalledTimes(3)
  expect(mocks.managerEnsure).toHaveBeenCalledOnce()
  finishUpdate(replacement)
  await update
})
